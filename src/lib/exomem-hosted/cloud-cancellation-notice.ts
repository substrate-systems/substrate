/**
 * Exomem Cloud cancellation notice: email 05 "Your Exomem subscription has
 * ended", and email 06 a week before deletion (item 5 / task 3.7, design D4,
 * `adopt-exomem-cloud-plain-cells`).
 *
 * Called from paddle-webhook.ts's post-commit Cloud hook, when a Cloud
 * tenant's Paddle source state transitions to "cancelled", and from the
 * periodic Cloud sweep, which retries a notice whose claim is still null.
 * Sent once per cancellation: one transaction claims the notice with
 * `UPDATE ... WHERE cancellation_notice_sent_at IS NULL` (migration 0057)
 * and enqueues the emails to the email outbox, which delivers them. A
 * second call for the same cell -- webhook redelivery, or any other caller
 * -- finds the column already set and enqueues nothing.
 */

import { DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS } from "./cloud-config";
import { cloudCancelledKeptUntil } from "./cloud-lifecycle";
import { executeExomemSql, withExomemTransaction } from "./db";
import { enqueueSubscriptionEndedEmails } from "./lifecycle-emails";

export type CloudCancellationNoticeDependencies = {
  retentionDays?: number;
  now?: () => Date;
};

/**
 * Returns whether this call claimed the notice and enqueued its emails
 * (`true`), or that there was nothing to do (`false`): the tenant's Cloud
 * cell is not a cancelled `read_only` cell, or the notice was already
 * claimed. Re-checking the state in the claim itself means a retry that
 * reaches a tenant who resubscribed after the batch was listed enqueues
 * nothing and leaves no stale claim behind. The claim's exact timestamp,
 * carried as `::text` because a JS `Date` drops its microseconds, names this
 * ended period in the emails' dedupe keys and their send-time re-check.
 *
 * `sourceOccurredAt` is the entitlement's own cancellation timestamp (the
 * Paddle event's `revision.occurredAt`) — the deletion date is computed from
 * it, exactly matching desiredCloudCellState's own 30-day export-window
 * arithmetic (design D4), not from whenever this function happens to run.
 */
export async function sendCloudCancellationNoticeOnce(
  tenantId: string,
  sourceOccurredAt: Date,
  dependencies: CloudCancellationNoticeDependencies = {}
): Promise<boolean> {
  const retentionDays = dependencies.retentionDays ?? DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS;
  const keptUntil = cloudCancelledKeptUntil(sourceOccurredAt, retentionDays);
  const now = dependencies.now?.() ?? new Date();
  return withExomemTransaction(async (tx) => {
    const { rows } = await tx`
      /* exomem-cloud:claim-cancellation-notice */
      UPDATE exomem_cloud_cells AS cell
      SET cancellation_notice_sent_at = now()
      FROM exomem_tenants AS tenant, users AS owner, exomem_entitlements AS entitlement
      WHERE cell.tenant_id = ${tenantId}::uuid
        AND cell.desired_state = 'read_only'
        AND cell.cancellation_notice_sent_at IS NULL
        AND entitlement.tenant_id = cell.tenant_id
        AND entitlement.source = 'paddle'
        AND entitlement.source_state = 'cancelled'
        AND tenant.id = cell.tenant_id
        AND owner.id = tenant.owner_user_id
      RETURNING owner.email::text AS email, tenant.time_zone, cell.cell_id,
                cell.cancellation_notice_sent_at::text AS claimed_at
    `;
    const claimed = rows[0] as
      | { email: string; time_zone: string | null; cell_id: string; claimed_at: string }
      | undefined;
    if (!claimed) return false;
    await enqueueSubscriptionEndedEmails(tx, {
      tenantId,
      cellId: claimed.cell_id,
      endedAt: claimed.claimed_at,
      keptUntil,
      recipient: claimed.email,
      timeZone: claimed.time_zone,
      now,
    });
    return true;
  });
}

export type CloudCancellationNoticeRetryResult = { attempted: number; sent: number };

/**
 * D4: the periodic sweep retries the notice for every cancelled `read_only`
 * cell whose claim is null -- a claim whose transaction failed, or one the
 * webhook never reached. The same claim guards it, so a retry that races
 * the webhook still enqueues once. Bounded per tick; each tenant is isolated, so one
 * failure never stops the rest.
 */
export async function retryPendingCloudCancellationNotices(
  dependencies: CloudCancellationNoticeDependencies & { limit?: number } = {}
): Promise<CloudCancellationNoticeRetryResult> {
  const limit = dependencies.limit ?? 20;
  const retentionDays = dependencies.retentionDays ?? DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS;
  // Only notices whose export window is still open: a notice that names a
  // deletion date already past is worse than none. Random order, so rows
  // whose claims keep failing cannot starve newer ones out of a bounded batch.
  const { rows } = await executeExomemSql`
    /* exomem-cloud:pending-cancellation-notices */
    SELECT cell.tenant_id, entitlement.source_occurred_at
    FROM exomem_cloud_cells AS cell
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
    WHERE cell.desired_state = 'read_only'
      AND cell.cancellation_notice_sent_at IS NULL
      AND entitlement.source = 'paddle'
      AND entitlement.source_state = 'cancelled'
      AND entitlement.source_occurred_at > now() - (${retentionDays} * interval '1 day')
    ORDER BY random()
    LIMIT ${limit}
  `;
  let sent = 0;
  for (const row of rows) {
    try {
      const occurredAt = new Date(row.source_occurred_at as string | Date);
      if (await sendCloudCancellationNoticeOnce(String(row.tenant_id), occurredAt, dependencies)) {
        sent += 1;
      }
    } catch {
      console.error("exomem-cloud: cancellation notice retry failed for one tenant");
    }
  }
  return { attempted: rows.length, sent };
}
