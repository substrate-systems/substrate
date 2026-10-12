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

const DAY_MS = 24 * 60 * 60 * 1000;
// Email 06 goes out this many days before an ended Exomem is deleted.
const DELETION_REMINDER_LEAD_DAYS = 7;

/** When email 06 is due for an Exomem kept until `keptUntil`. */
export function deletionReminderAt(keptUntil: Date): Date {
  return new Date(keptUntil.getTime() - DELETION_REMINDER_LEAD_DAYS * DAY_MS);
}

/**
 * Email 05, and email 06 for a week before deletion, in the transaction that
 * claims the cell's cancellation notice. `endedAt` is that claim, as the
 * database's exact text, so a later resubscribe-then-cancel is a new period
 * with new emails. Email 06 is queued only while more than a week is left:
 * otherwise 05 already gives the date, and "7 days left" would be untrue.
 * Neither row stores a deadline: the kept-until date can move, so each send
 * reads it again (email-outbox.ts).
 */
export async function enqueueSubscriptionEndedEmails(
  tx: ExomemSql,
  input: {
    tenantId: string;
    cellId: string;
    endedAt: string;
    keptUntil: Date;
    recipient: string;
    timeZone: string | null;
    now: Date;
  }
): Promise<{ reminderScheduled: boolean }> {
  const reminderAt = deletionReminderAt(input.keptUntil);
  const reminderScheduled = reminderAt.getTime() > input.now.getTime();
  if (reminderScheduled) {
    await enqueueExomemEmail(tx, {
      kind: "deletion_reminder",
      dedupeKey: `deletion-reminder:${input.cellId}:${input.endedAt}`,
      recipient: input.recipient,
      recipientTimeZone: input.timeZone,
      tenantId: input.tenantId,
      payload: { version: 1, cellId: input.cellId, endedAt: input.endedAt },
      notBefore: reminderAt,
    });
  }
  await enqueueExomemEmail(tx, {
    kind: "subscription_ended",
    dedupeKey: `subscription-ended:${input.cellId}:${input.endedAt}`,
    recipient: input.recipient,
    recipientTimeZone: input.timeZone,
    tenantId: input.tenantId,
    payload: {
      version: 1,
      cellId: input.cellId,
      endedAt: input.endedAt,
      reminderScheduled,
    },
  });
  return { reminderScheduled };
}

/**
 * Email 07, in the one transaction that deletes the Exomem: the cell's
 * day-30 deletion (cloud-lifecycle.ts) or the account deletion finish
 * (cloud-deletion-finish.ts), after that finish has scrubbed the account's
 * other emails. `deletedAt` is the tenant's `deleted_at` as the database's
 * exact text: it names this deletion, so a re-admission and a later deletion
 * can never revive this receipt. It goes out once cellctl has finished,
 * however long that takes: it has no deadline (email-outbox.ts).
 */
export async function enqueueDeletedEmail(
  tx: ExomemSql,
  input: { tenantId: string; deletedAt: string; recipient: string; timeZone: string | null }
): Promise<void> {
  await enqueueExomemEmail(tx, {
    kind: "deleted",
    dedupeKey: `deleted:${input.tenantId}:${input.deletedAt}`,
    recipient: input.recipient,
    recipientTimeZone: input.timeZone,
    tenantId: input.tenantId,
    payload: { version: 1, tenantId: input.tenantId, deletedAt: input.deletedAt },
  });
}

export type ReadyEmailSweepResult = { enqueued: number };

/**
 * Email 03. cellctl, not Substrate, writes a cell's readiness, so no
 * Substrate transaction holds the moment a cell becomes ready; this bounded
 * pass finds ready cells without email 03 and enqueues it, keyed by the cell.
 * Cells that had started before email 03 existed carry a settled row under the
 * same key (migration 0068), so they never get it. A marketplace reviewer's
 * tenant (`marketplace_reviewer_purpose`, set at admission and immutable) never
 * gets it either: it is a review fixture, not a person's Exomem.
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
      AND NOT tenant.marketplace_reviewer_purpose
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
        SELECT owner.email::text AS email, tenant.time_zone, tenant.id AS tenant_id
        FROM exomem_cloud_cells AS cell
        JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
        JOIN users AS owner ON owner.id = tenant.owner_user_id
        WHERE cell.cell_id = ${cellId}
          AND cell.ready
          AND tenant.status = 'active'
          AND NOT tenant.marketplace_reviewer_purpose
      `;
      const owner = owners[0] as
        | { email: string; time_zone: string | null; tenant_id: string }
        | undefined;
      if (!owner) return false;
      return enqueueExomemEmail(tx, {
        kind: "ready",
        dedupeKey: `ready:${cellId}`,
        recipient: owner.email,
        recipientTimeZone: owner.time_zone,
        tenantId: owner.tenant_id,
        payload: { version: 1, cellId },
      });
    });
    if (added) enqueued += 1;
  }
  return { enqueued };
}
