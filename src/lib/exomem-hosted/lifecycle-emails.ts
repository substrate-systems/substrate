/**
 * Enqueues the Exomem account lifecycle emails next to the facts they
 * announce: 03 (ready), 05 and 06 (ended, and a week before deletion) and 07
 * (deleted). Email 04 (payment failed) is enqueued by the Paddle projection's
 * own statement (paddle-event-store.ts). Each kind re-checks its fact when it
 * is sent (email-outbox.ts), and its dedupe key names the one fact it
 * announces, so it is sent once.
 */

import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { enqueueExomemEmail } from "./email-outbox";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Email 05, and email 06 for a week before deletion, in the transaction that
 * claims the cell's cancellation notice. `endedAt` is that claim, as the
 * database's exact text, so a later resubscribe-then-cancel is a new period
 * with new emails. Email 06 is queued only while more than a week is left:
 * otherwise 05 already gives the date, and "7 days left" would be untrue.
 */
export async function enqueueSubscriptionEndedEmails(
  tx: ExomemSql,
  input: {
    cellId: string;
    endedAt: string;
    keptUntil: Date;
    recipient: string;
    timeZone: string | null;
    now: Date;
  }
): Promise<{ reminderScheduled: boolean }> {
  const reminderAt = new Date(input.keptUntil.getTime() - WEEK_MS);
  const reminderScheduled = reminderAt.getTime() > input.now.getTime();
  if (reminderScheduled) {
    await enqueueExomemEmail(tx, {
      kind: "deletion_reminder",
      dedupeKey: `deletion-reminder:${input.cellId}:${input.endedAt}`,
      recipient: input.recipient,
      recipientTimeZone: input.timeZone,
      payload: { version: 1, cellId: input.cellId, endedAt: input.endedAt },
      notBefore: reminderAt,
      expiresAt: input.keptUntil,
    });
  }
  await enqueueExomemEmail(tx, {
    kind: "subscription_ended",
    dedupeKey: `subscription-ended:${input.cellId}:${input.endedAt}`,
    recipient: input.recipient,
    recipientTimeZone: input.timeZone,
    payload: {
      version: 1,
      cellId: input.cellId,
      endedAt: input.endedAt,
      reminderScheduled,
    },
    expiresAt: input.keptUntil,
  });
  return { reminderScheduled };
}

/**
 * Email 07, in the transaction that deletes the Exomem: the cell's day-30
 * deletion (cloud-lifecycle.ts) or the account deletion finish
 * (cloud-deletion-finish.ts), after that finish has scrubbed the person's
 * other emails.
 */
export async function enqueueDeletedEmail(
  tx: ExomemSql,
  input: { tenantId: string; deletedAt: Date; recipient: string; timeZone: string | null }
): Promise<void> {
  const deletedAt = input.deletedAt.toISOString();
  await enqueueExomemEmail(tx, {
    kind: "deleted",
    dedupeKey: `deleted:${input.tenantId}:${deletedAt}`,
    recipient: input.recipient,
    recipientTimeZone: input.timeZone,
    payload: { version: 1, tenantId: input.tenantId, deletedAt },
  });
}

export type ReadyEmailSweepResult = { enqueued: number };

/**
 * Email 03. cellctl, not Substrate, writes a cell's readiness, so no
 * Substrate transaction holds the moment a cell becomes ready; this bounded
 * pass finds ready cells without email 03 and enqueues it, keyed by the cell.
 * Cells that had started before email 03 existed carry a settled row under the
 * same key (migration 0068), so they never get it.
 */
export async function enqueueReadyEmails(limit = 20): Promise<ReadyEmailSweepResult> {
  const { rows } = await executeExomemSql`
    /* exomem:ready-email-candidates */
    SELECT cell.cell_id
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.ready
      AND cell.desired_state = 'running'
      AND cell.observed_state = 'running'
      AND tenant.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM exomem_email_outbox AS outbox
        WHERE outbox.dedupe_key = 'ready:' || cell.cell_id
      )
    ORDER BY cell.updated_at
    LIMIT ${Math.max(1, Math.min(Math.floor(limit), 100))}
  `;
  let enqueued = 0;
  for (const row of rows) {
    const cellId = String(row.cell_id);
    const added = await withExomemTransaction(async (tx) => {
      const { rows: owners } = await tx`
        /* exomem:ready-email-owner */
        SELECT owner.email::text AS email, tenant.time_zone
        FROM exomem_cloud_cells AS cell
        JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
        JOIN users AS owner ON owner.id = tenant.owner_user_id
        WHERE cell.cell_id = ${cellId} AND cell.ready AND tenant.status = 'active'
      `;
      const owner = owners[0] as { email: string; time_zone: string | null } | undefined;
      if (!owner) return false;
      return enqueueExomemEmail(tx, {
        kind: "ready",
        dedupeKey: `ready:${cellId}`,
        recipient: owner.email,
        recipientTimeZone: owner.time_zone,
        payload: { version: 1, cellId },
      });
    });
    if (added) enqueued += 1;
  }
  return { enqueued };
}
