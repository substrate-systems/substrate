/**
 * GDPR account deletion per contract §12.
 *
 * Synchronous Postgres cascade delete + audit-log row. A durable Paddle
 * cancellation tombstone is required before deletion; the provider call is
 * best effort and retries from that tombstone. The cascade statement itself
 * enqueues the user's R2 prefix into r2_purge_queue (the audit log
 * keeps only sha256(userId), so the prefix would otherwise be lost); the
 * daily backup-gc cron drains the queue within the /account UI's promised
 * 24-hour window.
 */

import { createHash } from "node:crypto";
import {
  getSubscriptionByUserId,
  insertAccountDeletionAudit,
  deleteUserCascade,
  enqueuePaddleCancellationTombstone,
  markPaddleCancellationAttempt,
} from "./db";
import { cancelPaddleSubscription } from "./subscriptions";
import { userPrefix } from "./r2";

export type DeleteAccountResult = {
  deleted: boolean;
  paddleCancelled: boolean;
  r2PrefixForPurge: string;
};

export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  // 1. Audit log row first — captures the intent even if a later step fails.
  const userIdHash = new Uint8Array(createHash("sha256").update(userId, "utf8").digest());
  await insertAccountDeletionAudit({ userIdHash, reason: "user_request" });

  // 2. Persist the cancellation obligation before deleting the only billing
  // mapping. A persistence failure is unsafe: abort rather than leave an
  // uncancellable provider subscription with no local identity.
  let paddleCancelled = false;
  const sub = await getSubscriptionByUserId(userId);
  if (sub?.paddle_subscription_id && sub.status !== "cancelled" && sub.status !== "none") {
    const tombstoneId = await enqueuePaddleCancellationTombstone({
      userIdHash,
      paddleSubscriptionId: sub.paddle_subscription_id,
    });
    try {
      paddleCancelled = await cancelPaddleSubscription(sub.paddle_subscription_id);
      if (paddleCancelled) {
        await markPaddleCancellationAttempt(tombstoneId, true);
      }
    } catch (err) {
      console.error("[hosted-backup deleteAccount] paddle cancel threw:", err);
    }
  } else {
    paddleCancelled = true; // nothing to cancel
  }

  // 3. Postgres cascade. FKs handle the rest.
  const removed = await deleteUserCascade(userId);

  return {
    deleted: removed > 0,
    paddleCancelled,
    r2PrefixForPurge: userPrefix(userId),
  };
}
