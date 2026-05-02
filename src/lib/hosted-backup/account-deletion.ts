/**
 * GDPR account deletion per contract §12.
 *
 * Synchronous Postgres cascade delete + audit-log row. Best-effort Paddle
 * subscription cancel (logs and continues on failure). R2 prefix is recorded
 * in the audit log for asynchronous purge by a future cron job.
 */

import { createHash } from 'node:crypto';
import {
  getSubscriptionByUserId,
  insertAccountDeletionAudit,
  deleteUserCascade,
} from './db';
import { cancelPaddleSubscription } from './subscriptions';
import { userPrefix } from './r2';

export type DeleteAccountResult = {
  deleted: boolean;
  paddleCancelled: boolean;
  r2PrefixForPurge: string;
};

export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  // 1. Audit log row first — captures the intent even if a later step fails.
  const userIdHash = new Uint8Array(
    createHash('sha256').update(userId, 'utf8').digest(),
  );
  await insertAccountDeletionAudit({ userIdHash, reason: 'user_request' });

  // 2. Best-effort Paddle cancel.
  let paddleCancelled = false;
  try {
    const sub = await getSubscriptionByUserId(userId);
    if (sub?.paddle_subscription_id && sub.status !== 'cancelled' && sub.status !== 'none') {
      paddleCancelled = await cancelPaddleSubscription(sub.paddle_subscription_id);
    } else {
      paddleCancelled = true; // nothing to cancel
    }
  } catch (err) {
    console.error('[hosted-backup deleteAccount] paddle cancel threw:', err);
  }

  // 3. Postgres cascade. FKs handle the rest.
  const removed = await deleteUserCascade(userId);

  return {
    deleted: removed > 0,
    paddleCancelled,
    r2PrefixForPurge: userPrefix(userId),
  };
}
