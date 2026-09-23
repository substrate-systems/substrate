/**
 * Exomem Cloud cancellation notice (item 5 / task 3.7, design D4,
 * `adopt-exomem-cloud-plain-cells`).
 *
 * Additive and gated: nothing here is called from any hosted code path.
 * Called only from paddle-webhook.ts's post-commit Cloud hook, when a Cloud
 * tenant's Paddle source state transitions to "cancelled". Sent once per
 * cancellation: `claimCloudCancellationNotice` atomically claims the send
 * with `UPDATE ... WHERE cancellation_notice_sent_at IS NULL` (migration
 * 0057), the same claim-then-act idiom every other one-time write in this
 * schema already uses (e.g. `exomem_invites.consumed_at`). A second call for
 * the same cell -- webhook redelivery, or any other caller -- finds the
 * column already set and sends nothing.
 */

import { sendTransactionalEmail, type SendTransactionalEmailResult } from "@/lib/brevo";
import { renderExomemCloudCancellationEmail } from "@/lib/email-templates/exomem-access";
import { DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS } from "./cloud-config";
import { executeExomemSql } from "./db";

export type CloudCancellationNoticeDependencies = {
  sendEmail?: (input: {
    to: string;
    senderName: string;
    subject: string;
    htmlContent: string;
    textContent: string;
  }) => Promise<SendTransactionalEmailResult>;
  retentionDays?: number;
};

/**
 * Claims the send and returns the owner's email and the exact claimed
 * timestamp, or `null` if there is no live (non-deleted) Cloud cell for this
 * tenant, or the notice was already claimed by an earlier call. The claim
 * and the email lookup happen in the same statement, so nothing observes
 * "claimed" without also having the address to send to. The returned
 * timestamp is what a failed send's un-claim matches against, so it only
 * ever reverts its own claim, never a newer one from a since-cancelled-again
 * cycle. It is carried as `::text`, never parsed into a JS `Date`: `pg`
 * parses a `timestamptz` column into a `Date`, which only holds millisecond
 * precision, while the column itself holds microseconds -- round-tripping
 * through `Date` would make the un-claim's exact-timestamp match fail almost
 * every time. Going through `text` on both sides of the round trip avoids
 * that loss entirely.
 */
async function claimCloudCancellationNotice(
  tenantId: string
): Promise<{ email: string; claimedAt: string } | null> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:claim-cancellation-notice */
    UPDATE exomem_cloud_cells AS cell
    SET cancellation_notice_sent_at = now()
    FROM exomem_tenants AS tenant, users AS owner
    WHERE cell.tenant_id = ${tenantId}::uuid
      AND cell.desired_state <> 'deleted'
      AND cell.cancellation_notice_sent_at IS NULL
      AND tenant.id = cell.tenant_id
      AND owner.id = tenant.owner_user_id
    RETURNING owner.email AS email, cell.cancellation_notice_sent_at::text AS claimed_at
  `;
  const row = rows[0] as { email: string; claimed_at: string } | undefined;
  return row ? { email: row.email, claimedAt: row.claimed_at } : null;
}

/**
 * Reverts a claim that turned out not to have actually sent anything
 * (security review finding 9): matched on the exact claimed timestamp, so a
 * concurrent or later claim (a fresh cancellation, or the cell returning to
 * running) is never clobbered.
 */
async function unclaimCloudCancellationNotice(tenantId: string, claimedAt: string): Promise<void> {
  await executeExomemSql`
    /* exomem-cloud:unclaim-cancellation-notice */
    UPDATE exomem_cloud_cells
    SET cancellation_notice_sent_at = NULL
    WHERE tenant_id = ${tenantId}::uuid
      AND cancellation_notice_sent_at = ${claimedAt}::timestamptz
  `;
}

/**
 * Returns whether it sent the notice (`true`), or that there was nothing to
 * send (`false`): no live Cloud cell for this tenant, it was already sent,
 * or the send itself failed (its claim is reverted so a later cancellation
 * -- or a retry -- can try again). Callers that only care about "did this
 * run at least once" (the Paddle hook's best-effort try/catch) can ignore
 * the return value.
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
  const claimed = await claimCloudCancellationNotice(tenantId);
  if (!claimed) return false;

  const retentionDays = dependencies.retentionDays ?? DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS;
  const deletionDate = new Date(sourceOccurredAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
  const rendered = renderExomemCloudCancellationEmail({ deletionDate, retentionDays });
  const sendEmail = dependencies.sendEmail ?? sendTransactionalEmail;
  const result = await sendEmail({
    to: claimed.email,
    senderName: "Exomem",
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    textContent: rendered.textContent,
  });
  if (!result.success) {
    await unclaimCloudCancellationNotice(tenantId, claimed.claimedAt);
    console.error("exomem-cloud: cancellation notice send failed, claim released");
    return false;
  }
  return true;
}
