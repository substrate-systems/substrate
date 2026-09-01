/**
 * Neon Postgres queries for Hosted Backup auth.
 * Mirrors the lazy-singleton, template-literal pattern in `src/lib/license/db.ts`.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { KdfParams, SubscriptionStatus } from "./types";

let _sql: NeonQueryFunction<false, true> | null = null;

export type HostedBackupSqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};

export type HostedBackupSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<HostedBackupSqlResult>;

let _injectedSql: HostedBackupSql | null = null;

function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<HostedBackupSqlResult> {
  if (_injectedSql) return _injectedSql(strings, ...values);
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _sql = neon(url, { fullResults: true });
  }
  return _sql(strings, ...values) as Promise<HostedBackupSqlResult>;
}

/**
 * Test seam, mirroring `__setExomemSqlForTests` in the sibling module. Lets an
 * integration suite point these queries at a real Postgres (via a `pg` pool
 * wrapped in the same tagged-template shape) so the SQL in this file — not a
 * copy of it, and not a mock standing in for it — is what gets exercised.
 * Pass `null` to restore the Neon client.
 */
export function __setHostedBackupSqlForTests(next: HostedBackupSql | null): void {
  _injectedSql = next;
}

// --- Row types ---

export type UserRow = {
  id: string;
  email: string;
  email_verified_at: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type AuthCredentialsRow = {
  user_id: string;
  server_password_hash: string;
  client_salt: Uint8Array;
  kdf_params: KdfParams;
  wrapped_dek: Uint8Array;
  recovery_key_verifier: string;
  recovery_key_wrapped_dek: Uint8Array;
  updated_at: string;
};

export type RefreshTokenRow = {
  id: string;
  user_id: string;
  chain_id: string;
  parent_id: string | null;
  token_hash: Uint8Array;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
};

export type SigningKeyRow = {
  kid: string;
  public_key: Uint8Array;
  algorithm: string;
  created_at: string;
  retired_at: string | null;
};

// --- Users ---

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await sql`
    SELECT id, email, email_verified_at, created_at, deleted_at
    FROM users
    WHERE email = ${email} AND deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as UserRow | undefined) ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await sql`
    SELECT id, email, email_verified_at, created_at, deleted_at
    FROM users
    WHERE id = ${id} AND deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as UserRow | undefined) ?? null;
}

export async function insertUser(email: string): Promise<UserRow> {
  const { rows } = await sql`
    INSERT INTO users (email)
    VALUES (${email})
    RETURNING id, email, email_verified_at, created_at, deleted_at
  `;
  return rows[0] as UserRow;
}

// Insert-or-fetch the users row for `email` (citext, case-insensitive). Used
// by the Paddle webhook when an unauthenticated marketing-page checkout
// arrives — we mint a pre-account (users row without auth_credentials) so the
// subscription can attach to a real user_id. Concurrent webhooks for the same
// email are safe: ON CONFLICT DO NOTHING + a follow-up SELECT in the same
// statement returns the canonical row. `isNew` is true when this call
// inserted the row.
export async function ensurePreAccount(email: string): Promise<{ userId: string; isNew: boolean }> {
  const { rows } = await sql`
    WITH ins AS (
      INSERT INTO users (email)
      VALUES (${email})
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    )
    SELECT id, TRUE AS is_new FROM ins
    UNION ALL
    SELECT id, FALSE AS is_new FROM users
      WHERE email = ${email}
        AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ins)
    LIMIT 1
  `;
  const row = rows[0] as { id: string; is_new: boolean } | undefined;
  if (!row) {
    throw new Error("ensurePreAccount: no row returned (user is soft-deleted?)");
  }
  return { userId: row.id, isNew: row.is_new };
}

// Cheap presence check, used by the webhook + signup paths to distinguish a
// pre-account (no credentials yet) from a fully-credentialed user.
export async function userHasAuthCredentials(userId: string): Promise<boolean> {
  const { rows } = await sql`
    SELECT 1 FROM auth_credentials WHERE user_id = ${userId} LIMIT 1
  `;
  return rows.length > 0;
}

// --- Auth credentials ---

export async function insertAuthCredentials(params: {
  userId: string;
  serverPasswordHash: string;
  clientSalt: Uint8Array;
  kdfParams: KdfParams;
  wrappedDek: Uint8Array;
  recoveryKeyVerifier: string;
  recoveryKeyWrappedDek: Uint8Array;
}): Promise<void> {
  await sql`
    INSERT INTO auth_credentials (
      user_id, server_password_hash, client_salt, kdf_params,
      wrapped_dek, recovery_key_verifier, recovery_key_wrapped_dek
    ) VALUES (
      ${params.userId},
      ${params.serverPasswordHash},
      ${Buffer.from(params.clientSalt)},
      ${JSON.stringify(params.kdfParams)}::jsonb,
      ${Buffer.from(params.wrappedDek)},
      ${params.recoveryKeyVerifier},
      ${Buffer.from(params.recoveryKeyWrappedDek)}
    )
  `;
}

export async function getAuthCredentials(userId: string): Promise<AuthCredentialsRow | null> {
  const { rows } = await sql`
    SELECT user_id, server_password_hash, client_salt, kdf_params,
           wrapped_dek, recovery_key_verifier, recovery_key_wrapped_dek, updated_at
    FROM auth_credentials
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  return (rows[0] as AuthCredentialsRow | undefined) ?? null;
}

export async function updateAuthCredentialsForRecovery(params: {
  userId: string;
  serverPasswordHash: string;
  clientSalt: Uint8Array;
  kdfParams: KdfParams;
  wrappedDek: Uint8Array;
}): Promise<void> {
  await sql`
    UPDATE auth_credentials
    SET server_password_hash = ${params.serverPasswordHash},
        client_salt = ${Buffer.from(params.clientSalt)},
        kdf_params = ${JSON.stringify(params.kdfParams)}::jsonb,
        wrapped_dek = ${Buffer.from(params.wrappedDek)},
        updated_at = now()
    WHERE user_id = ${params.userId}
  `;
}

// Atomically apply the three writes that finalize a recovery: burn the
// recovery token (jti → recovery_tokens_used), update credentials, and
// revoke all live refresh chains. All three roll back together if any
// fails — closing the crash-window between burn and update that would
// otherwise leave a token consumed but credentials unchanged. Contract §6.
//
// Returns `tokenAlreadyUsed: true` on primary-key collision in
// recovery_tokens_used (i.e. a replay or concurrent finalize). The caller
// translates that into RECOVERY_TOKEN_EXPIRED. Other errors propagate.
export async function recoverFinalizeAtomic(params: {
  jti: string;
  userId: string;
  serverPasswordHash: string;
  clientSalt: Uint8Array;
  kdfParams: KdfParams;
  wrappedDek: Uint8Array;
}): Promise<{ tokenAlreadyUsed: boolean }> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _sql = neon(url, { fullResults: true });
  }
  try {
    await _sql.transaction((tx) => [
      tx`
        INSERT INTO recovery_tokens_used (jti, user_id)
        VALUES (${params.jti}, ${params.userId})
      `,
      tx`
        UPDATE auth_credentials
        SET server_password_hash = ${params.serverPasswordHash},
            client_salt = ${Buffer.from(params.clientSalt)},
            kdf_params = ${JSON.stringify(params.kdfParams)}::jsonb,
            wrapped_dek = ${Buffer.from(params.wrappedDek)},
            updated_at = now()
        WHERE user_id = ${params.userId}
      `,
      tx`
        UPDATE refresh_tokens
        SET revoked_at = now()
        WHERE user_id = ${params.userId}
          AND revoked_at IS NULL
      `,
    ]);
    return { tokenAlreadyUsed: false };
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      return { tokenAlreadyUsed: true };
    }
    throw err;
  }
}

// --- Refresh tokens ---

export async function insertRefreshToken(params: {
  userId: string;
  chainId: string;
  parentId: string | null;
  tokenHash: Uint8Array;
  expiresAt: Date;
}): Promise<RefreshTokenRow> {
  const { rows } = await sql`
    INSERT INTO refresh_tokens (
      user_id, chain_id, parent_id, token_hash, expires_at
    ) VALUES (
      ${params.userId},
      ${params.chainId},
      ${params.parentId},
      ${Buffer.from(params.tokenHash)},
      ${params.expiresAt.toISOString()}
    )
    RETURNING id, user_id, chain_id, parent_id, token_hash,
              issued_at, expires_at, revoked_at
  `;
  return rows[0] as RefreshTokenRow;
}

export async function findRefreshTokenByHash(
  tokenHash: Uint8Array
): Promise<RefreshTokenRow | null> {
  const { rows } = await sql`
    SELECT id, user_id, chain_id, parent_id, token_hash,
           issued_at, expires_at, revoked_at
    FROM refresh_tokens
    WHERE token_hash = ${Buffer.from(tokenHash)}
    LIMIT 1
  `;
  return (rows[0] as RefreshTokenRow | undefined) ?? null;
}

export async function getChainRoot(chainId: string): Promise<RefreshTokenRow | null> {
  const { rows } = await sql`
    SELECT id, user_id, chain_id, parent_id, token_hash,
           issued_at, expires_at, revoked_at
    FROM refresh_tokens
    WHERE chain_id = ${chainId} AND parent_id IS NULL
    LIMIT 1
  `;
  return (rows[0] as RefreshTokenRow | undefined) ?? null;
}

export async function revokeRefreshToken(id: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET revoked_at = now()
    WHERE id = ${id} AND revoked_at IS NULL
  `;
}

export async function revokeRefreshChain(chainId: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET revoked_at = now()
    WHERE chain_id = ${chainId} AND revoked_at IS NULL
  `;
}

export async function revokeAllRefreshChainsForUser(userId: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

// --- Signing keys ---

export async function getActiveAndRecentlyRetiredSigningKeys(): Promise<SigningKeyRow[]> {
  const { rows } = await sql`
    SELECT kid, public_key, algorithm, created_at, retired_at
    FROM signing_keys
    WHERE retired_at IS NULL
       OR retired_at > now() - interval '24 hours'
    ORDER BY created_at DESC
  `;
  return rows as SigningKeyRow[];
}

export async function getJwksKeys(): Promise<SigningKeyRow[]> {
  // Same set as verifier accepts. Engine and any external verifier read this.
  return getActiveAndRecentlyRetiredSigningKeys();
}

export async function insertSigningKey(params: {
  kid: string;
  publicKey: Uint8Array;
  algorithm?: string;
}): Promise<void> {
  await sql`
    INSERT INTO signing_keys (kid, public_key, algorithm)
    VALUES (
      ${params.kid},
      ${Buffer.from(params.publicKey)},
      ${params.algorithm ?? "EdDSA"}
    )
  `;
}

export async function retireSigningKey(kid: string): Promise<void> {
  await sql`
    UPDATE signing_keys
    SET retired_at = now()
    WHERE kid = ${kid} AND retired_at IS NULL
  `;
}

// --- Subscriptions ---

export type SubscriptionRow = {
  user_id: string;
  paddle_subscription_id: string | null;
  paddle_customer_id: string | null;
  status: SubscriptionStatus;
  plan: string | null;
  grace_started_at: string | null;
  cancel_started_at: string | null;
  current_period_end: string | null;
  scheduled_cancel_at: string | null;
  updated_at: string;
};

// Past-due grace window per hosted-backup contract §10: Paddle's `past_due`
// keeps a user entitled for this many days, then they are cut off at read
// time. The stored row is left as `grace` so a late `subscription.activated`
// from Paddle can still recover the user without an extra state path.
//
// 30, not 14: the published contract §10 and the public Terms both promise a
// 30-day grace window. The code said 14, which cut paying customers off two
// weeks before we told them we would. Correcting upward is user-favourable
// and makes the promise true.
export const GRACE_WINDOW_DAYS = 30;

// Post-cancellation retention per contract §10 and the public Terms ("retained
// for 30 days to allow reactivation, then permanently deleted"). Two things
// hang off this one constant so the promise and the deletion cannot drift:
// the read-time `cancelled → none` cutoff below, and the backup-gc pass that
// purges the blobs and downgrades the stored row.
export const CANCELLED_RETENTION_DAYS = 30;

export async function getSubscriptionStatus(userId: string): Promise<SubscriptionStatus> {
  const { rows } = await sql`
    SELECT
      CASE
        WHEN status = 'grace'
         AND grace_started_at IS NOT NULL
         AND grace_started_at < now() - (${GRACE_WINDOW_DAYS} || ' days')::interval
        THEN 'cancelled'
        WHEN status = 'cancelled'
         AND cancel_started_at IS NOT NULL
         AND cancel_started_at < now() - (${CANCELLED_RETENTION_DAYS} || ' days')::interval
        THEN 'none'
        ELSE status
      END AS effective_status
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  const row = rows[0] as { effective_status: SubscriptionStatus } | undefined;
  return row?.effective_status ?? "none";
}

export type SubscriptionEntitlement = {
  effectiveStatus: SubscriptionStatus;
  storedStatus: SubscriptionStatus;
  plan: string | null;
  currentPeriodEnd: string | null;
  scheduledCancelAt: string | null;
  gracePeriodEndsAt: string | null;
  retentionEndsAt: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  updatedAt: string | null;
};

/**
 * Returns the full debug view of a user's subscription, including the
 * grace-cutoff- and cancellation-retention-adjusted effective status and a
 * computed grace period end. Used by `GET /api/account/me`. Kept in lockstep
 * with `getSubscriptionStatus` above — the gates read that one, this one is
 * what the user is shown, and they must agree.
 */
export async function getSubscriptionEntitlement(userId: string): Promise<SubscriptionEntitlement> {
  const { rows } = await sql`
    SELECT
      status,
      plan,
      current_period_end,
      scheduled_cancel_at,
      grace_started_at,
      paddle_subscription_id,
      paddle_customer_id,
      updated_at,
      CASE
        WHEN status = 'grace'
         AND grace_started_at IS NOT NULL
         AND grace_started_at < now() - (${GRACE_WINDOW_DAYS} || ' days')::interval
        THEN 'cancelled'
        WHEN status = 'cancelled'
         AND cancel_started_at IS NOT NULL
         AND cancel_started_at < now() - (${CANCELLED_RETENTION_DAYS} || ' days')::interval
        THEN 'none'
        ELSE status
      END AS effective_status,
      CASE
        WHEN status = 'grace' AND grace_started_at IS NOT NULL
        THEN grace_started_at + (${GRACE_WINDOW_DAYS} || ' days')::interval
        ELSE NULL
      END AS grace_period_ends_at
      , CASE
        WHEN status = 'grace' AND grace_started_at IS NOT NULL
        THEN grace_started_at + ((${GRACE_WINDOW_DAYS}::int + ${CANCELLED_RETENTION_DAYS}::int) || ' days')::interval
        WHEN status = 'cancelled' AND cancel_started_at IS NOT NULL
        THEN cancel_started_at + (${CANCELLED_RETENTION_DAYS} || ' days')::interval
        ELSE NULL
      END AS retention_ends_at
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  const row = rows[0] as
    | {
        status: SubscriptionStatus;
        plan: string | null;
        current_period_end: string | null;
        scheduled_cancel_at: string | null;
        grace_started_at: string | null;
        paddle_subscription_id: string | null;
        paddle_customer_id: string | null;
        updated_at: string;
        effective_status: SubscriptionStatus;
        grace_period_ends_at: string | null;
        retention_ends_at: string | null;
      }
    | undefined;
  if (!row) {
    return {
      effectiveStatus: "none",
      storedStatus: "none",
      plan: null,
      currentPeriodEnd: null,
      scheduledCancelAt: null,
      gracePeriodEndsAt: null,
      retentionEndsAt: null,
      paddleSubscriptionId: null,
      paddleCustomerId: null,
      updatedAt: null,
    };
  }
  return {
    effectiveStatus: row.effective_status,
    storedStatus: row.status,
    plan: row.plan,
    currentPeriodEnd: row.current_period_end,
    scheduledCancelAt: row.scheduled_cancel_at,
    gracePeriodEndsAt: row.grace_period_ends_at,
    retentionEndsAt: row.retention_ends_at,
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleCustomerId: row.paddle_customer_id,
    updatedAt: row.updated_at,
  };
}

export async function getSubscriptionByUserId(userId: string): Promise<SubscriptionRow | null> {
  const { rows } = await sql`
    SELECT user_id, paddle_subscription_id, paddle_customer_id, status, plan,
           grace_started_at, cancel_started_at, current_period_end,
           scheduled_cancel_at, updated_at
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  return (rows[0] as SubscriptionRow | undefined) ?? null;
}

export async function getSubscriptionByPaddleId(
  paddleSubscriptionId: string
): Promise<SubscriptionRow | null> {
  const { rows } = await sql`
    SELECT user_id, paddle_subscription_id, paddle_customer_id, status, plan,
           grace_started_at, cancel_started_at, current_period_end,
           scheduled_cancel_at, updated_at
    FROM subscriptions WHERE paddle_subscription_id = ${paddleSubscriptionId} LIMIT 1
  `;
  return (rows[0] as SubscriptionRow | undefined) ?? null;
}

export async function findUserIdByPaddleCustomerId(
  paddleCustomerId: string
): Promise<string | null> {
  const { rows } = await sql`
    SELECT user_id FROM subscriptions WHERE paddle_customer_id = ${paddleCustomerId} LIMIT 1
  `;
  return (rows[0] as { user_id: string } | undefined)?.user_id ?? null;
}

export async function upsertSubscription(params: {
  userId: string;
  paddleSubscriptionId: string;
  paddleCustomerId: string;
  status: SubscriptionStatus;
  plan?: string | null;
  graceStartedAt?: Date | null;
  cancelStartedAt?: Date | null;
  currentPeriodEnd?: Date | null;
  scheduledCancelAt?: Date | null;
  providerEventOccurredAt: Date;
  providerEventId: string;
}): Promise<void> {
  await sql`
    INSERT INTO subscriptions (
      user_id, paddle_subscription_id, paddle_customer_id, status, plan,
      grace_started_at, cancel_started_at, current_period_end,
      scheduled_cancel_at, provider_event_occurred_at, provider_event_id, updated_at
    ) VALUES (
      ${params.userId},
      ${params.paddleSubscriptionId},
      ${params.paddleCustomerId},
      ${params.status},
      ${params.plan ?? null},
      ${params.graceStartedAt?.toISOString() ?? null},
      ${params.cancelStartedAt?.toISOString() ?? null},
      ${params.currentPeriodEnd?.toISOString() ?? null},
      ${params.scheduledCancelAt?.toISOString() ?? null},
      ${params.providerEventOccurredAt.toISOString()},
      ${params.providerEventId},
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      paddle_subscription_id = EXCLUDED.paddle_subscription_id,
      paddle_customer_id = EXCLUDED.paddle_customer_id,
      status = EXCLUDED.status,
      plan = EXCLUDED.plan,
      grace_started_at = EXCLUDED.grace_started_at,
      cancel_started_at = EXCLUDED.cancel_started_at,
      current_period_end = EXCLUDED.current_period_end,
      scheduled_cancel_at = EXCLUDED.scheduled_cancel_at,
      provider_event_occurred_at = EXCLUDED.provider_event_occurred_at,
      provider_event_id = EXCLUDED.provider_event_id,
      updated_at = now()
    WHERE subscriptions.provider_event_occurred_at IS NULL
      OR EXCLUDED.provider_event_occurred_at > subscriptions.provider_event_occurred_at
      OR (
        EXCLUDED.provider_event_occurred_at = subscriptions.provider_event_occurred_at
        AND EXCLUDED.provider_event_id > subscriptions.provider_event_id
      )
  `;
}

// --- Paddle webhook events (idempotency + processing lease) ---

export type PaddleEventProcessingClaim =
  | { kind: "acquired"; attempt: number }
  | { kind: "processed" }
  | { kind: "in_progress" };

const PADDLE_EVENT_PROCESSING_LEASE_MINUTES = 5;

export async function claimPaddleEventProcessing(params: {
  eventId: string;
  eventType: string;
}): Promise<PaddleEventProcessingClaim> {
  const claimed = await sql`
    INSERT INTO paddle_webhook_events (
      event_id, event_type, processing_started_at, attempt_count
    ) VALUES (
      ${params.eventId}, ${params.eventType}, now(), 1
    )
    ON CONFLICT (event_id) DO UPDATE SET
      event_type = EXCLUDED.event_type,
      processing_started_at = now(),
      attempt_count = paddle_webhook_events.attempt_count + 1
    WHERE paddle_webhook_events.processed_at IS NULL
      AND (
        paddle_webhook_events.processing_started_at IS NULL
        OR paddle_webhook_events.processing_started_at
          < now() - (${PADDLE_EVENT_PROCESSING_LEASE_MINUTES} || ' minutes')::interval
      )
    RETURNING attempt_count
  `;
  const acquired = claimed.rows[0] as { attempt_count: number } | undefined;
  if (acquired) return { kind: "acquired", attempt: acquired.attempt_count };

  const existing = await sql`
    SELECT processed_at
    FROM paddle_webhook_events
    WHERE event_id = ${params.eventId}
    LIMIT 1
  `;
  const row = existing.rows[0] as { processed_at: string | null } | undefined;
  if (row?.processed_at) return { kind: "processed" };
  return { kind: "in_progress" };
}

export async function releasePaddleEventForRetry(
  eventId: string,
  attempt: number,
  errorCode: string
): Promise<void> {
  await sql`
    UPDATE paddle_webhook_events
    SET processing_started_at = NULL,
        last_error_code = ${errorCode},
        last_error_at = now()
    WHERE event_id = ${eventId}
      AND attempt_count = ${attempt}
      AND processed_at IS NULL
  `;
}

export async function markPaddleEventProcessed(eventId: string, attempt: number): Promise<void> {
  const result = await sql`
    UPDATE paddle_webhook_events
    SET processed_at = now(),
        processing_started_at = NULL,
        last_error_code = NULL,
        last_error_at = NULL
    WHERE event_id = ${eventId}
      AND attempt_count = ${attempt}
      AND processed_at IS NULL
  `;
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("PADDLE_EVENT_LEASE_LOST");
  }
}

/**
 * Operator-only compatibility import for the real pre-tier €89 purchase.
 * The original Paddle transaction/event identities make this idempotent; its
 * original occurrence timestamp is retained for the receipt timeline. The
 * historical thank-you/founder obligations are recorded as fulfilled so an
 * import can never send a surprise duplicate email. Recognition remains
 * pending explicit reply-based consent.
 *
 * This is the only remaining writer of these tables: the Paddle supporter
 * purchase path and its mail outbox drain were retired when voluntary support
 * moved to GitHub Sponsors, and the rows are kept as history.
 */
export async function recordLegacySupporterContribution(params: {
  transactionId: string;
  eventId: string;
  occurredAt: Date;
  email: string | null;
}): Promise<boolean> {
  const { rows } = await sql`
    WITH contribution AS (
      INSERT INTO supporter_contributions (
        paddle_transaction_id, paddle_event_id, tier, customer_email, created_at
      ) VALUES (
        ${params.transactionId}, ${params.eventId}, 'patron', ${params.email}, ${params.occurredAt.toISOString()}
      )
      ON CONFLICT DO NOTHING
      RETURNING paddle_transaction_id, created_at
    ), fulfilled_obligations AS (
      INSERT INTO supporter_email_outbox (
        paddle_transaction_id, kind, attempts, sent_at, created_at
      )
      SELECT paddle_transaction_id, kind, 1, created_at, created_at
      FROM contribution
      CROSS JOIN (VALUES ('founder_notification'::text), ('supporter_thank_you'::text)) t(kind)
      ON CONFLICT DO NOTHING
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM contribution) AS inserted
  `;
  return Boolean((rows[0] as { inserted: boolean } | undefined)?.inserted);
}

export type SubscriptionOnboardingClaim =
  | { kind: "acquired" }
  | { kind: "already_sent" }
  | { kind: "in_progress" };

export async function claimSubscriptionOnboardingDelivery(params: {
  paddleSubscriptionId: string;
  eventId: string;
  emailKind: "claim" | "fyi";
}): Promise<SubscriptionOnboardingClaim> {
  const claimed = await sql`
    UPDATE subscriptions
    SET onboarding_source_event_id = ${params.eventId},
        onboarding_email_kind = ${params.emailKind},
        onboarding_processing_started_at = now(),
        onboarding_email_attempts = onboarding_email_attempts + 1,
        onboarding_last_error_code = NULL
    WHERE paddle_subscription_id = ${params.paddleSubscriptionId}
      AND onboarding_email_sent_at IS NULL
      AND (
        onboarding_source_event_id IS NULL
        OR onboarding_source_event_id = ${params.eventId}
        OR (
          onboarding_processing_started_at IS NULL
          OR onboarding_processing_started_at
            < now() - (${PADDLE_EVENT_PROCESSING_LEASE_MINUTES} || ' minutes')::interval
        )
      )
    RETURNING onboarding_email_sent_at
  `;
  const row = claimed.rows[0] as { onboarding_email_sent_at: string | null } | undefined;
  if (row?.onboarding_email_sent_at) return { kind: "already_sent" };
  if (row) return { kind: "acquired" };

  const existing = await sql`
    SELECT onboarding_email_sent_at
    FROM subscriptions
    WHERE paddle_subscription_id = ${params.paddleSubscriptionId}
    LIMIT 1
  `;
  const delivery = existing.rows[0] as { onboarding_email_sent_at: string | null } | undefined;
  if (delivery?.onboarding_email_sent_at) return { kind: "already_sent" };
  return { kind: "in_progress" };
}

export async function markSubscriptionOnboardingSent(params: {
  paddleSubscriptionId: string;
  eventId: string;
  messageId?: string;
}): Promise<void> {
  const result = await sql`
    UPDATE subscriptions
    SET onboarding_email_sent_at = now(),
        onboarding_processing_started_at = NULL,
        onboarding_email_message_id = ${params.messageId ?? null},
        onboarding_last_error_code = NULL
    WHERE paddle_subscription_id = ${params.paddleSubscriptionId}
      AND onboarding_source_event_id = ${params.eventId}
      AND onboarding_email_sent_at IS NULL
  `;
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error("ONBOARDING_DELIVERY_LEASE_LOST");
  }
}

export async function releaseSubscriptionOnboardingForRetry(params: {
  paddleSubscriptionId: string;
  eventId: string;
  errorCode: string;
}): Promise<void> {
  await sql`
    UPDATE subscriptions
    SET onboarding_processing_started_at = NULL,
        onboarding_last_error_code = ${params.errorCode}
    WHERE paddle_subscription_id = ${params.paddleSubscriptionId}
      AND onboarding_source_event_id = ${params.eventId}
      AND onboarding_email_sent_at IS NULL
  `;
}

// --- Backups (storage) ---

export type BackupRow = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type BackupVersionRow = {
  id: string;
  backup_id: string;
  created_at: string;
  size_bytes: number;
  manifest_size_bytes: number;
  manifest_object_key: string;
  manifest_sha256: Uint8Array;
  chunk_count: number;
  deleted_at: string | null;
  committed_at: string | null;
  requires_commit: boolean;
  client_commit_required: boolean;
  client_operation_id: string | null;
  gc_reclaim_token: string | null;
  replay_fence_token?: string | null;
  replay_fence_expires_at?: string | null;
  legacy_unverified: boolean;
  legacy_quarantined?: boolean;
};

export type BackupVersionOperationRow = {
  user_id: string;
  backup_id: string;
  operation_id: string;
  version_id: string;
  manifest_size_bytes: number;
  manifest_sha256: Uint8Array;
  chunk_metadata: Array<{ index: number; encryptedSize: number; sha256: string }>;
  committed_at: string | null;
};

/**
 * The version-visibility rule (contract §8), stated once here because it is
 * repeated inline in every read query below — Neon's tagged-template client
 * has no way to compose a SQL fragment, so the predicate is written out each
 * time rather than built by string concatenation.
 *
 *     deleted_at IS NULL
 *       AND (
 *         (committed_at IS NOT NULL AND legacy_unverified = false)
 *         OR (legacy_unverified = true AND created_at < policy.legacy_cutoff
 *             AND policy.strict_generation_visibility = false)
 *       )
 *
 * A version is normally visible only after publication. Release A retains a
 * deliberate, DB-governed bridge for rows that pre-date migration 0040: they
 * remain available while strict visibility is false, then the bounded verifier
 * publishes or quarantines them before the guarded cutover. Rows minted after
 * the cutoff never borrow that bridge.
 *
 * Every surface that answers "what does this user have?" must apply it:
 * `listVersions`, `listBackupsForUser`, `sumActiveStorageForUser`,
 * `getUserBackupStats`, `getVersionOwned`, and the retention prune. The
 * pending-only `getVersionForCommitOwned` is the deliberate exception — the
 * commit endpoint has to be able to find the version it is about to publish.
 */

export type BackupChunkRow = {
  version_id: string;
  chunk_index: number;
  object_key: string;
  size_bytes: number;
  sha256: Uint8Array;
};

export type BackupSummaryRow = BackupRow & {
  latest_version_id: string | null;
  version_count: number;
  total_size: number;
};

export type GenerationVisibilityPolicy = {
  strictGenerationVisibility: boolean;
  legacyCutoff: string;
  pendingPreCutoffLegacyVersions: number;
};

/**
 * Release-A visibility policy. It is a singleton in Postgres rather than an
 * environment flag so every request observes the same cutover, including
 * concurrent Vercel instances. The only writer is the guarded manual command.
 */
export async function getGenerationVisibilityPolicy(): Promise<GenerationVisibilityPolicy> {
  const { rows } = await sql`
    SELECT p.strict_generation_visibility, p.legacy_cutoff,
      COUNT(v.id)::int AS pending_pre_cutoff_legacy_versions
    FROM hosted_backup_generation_visibility_policy p
    LEFT JOIN backup_versions v
      ON v.deleted_at IS NULL
      AND v.legacy_unverified = true AND v.legacy_quarantined = false
      AND v.created_at < p.legacy_cutoff
    WHERE p.singleton = true
    GROUP BY p.strict_generation_visibility, p.legacy_cutoff
  `;
  const row = rows[0] as
    | {
        strict_generation_visibility: boolean;
        legacy_cutoff: string;
        pending_pre_cutoff_legacy_versions: number;
      }
    | undefined;
  if (!row) throw new Error("hosted backup generation visibility policy is missing");
  return {
    strictGenerationVisibility: row.strict_generation_visibility,
    legacyCutoff: row.legacy_cutoff,
    pendingPreCutoffLegacyVersions: Number(row.pending_pre_cutoff_legacy_versions),
  };
}

export type StrictGenerationVisibilityCutover =
  | "enabled"
  | "already_strict"
  | "blocked_pending_legacy";

/**
 * Atomically enables strict visibility only after every pre-cutoff legacy row
 * has either been verified or deliberately removed. It is safe to rerun and
 * never turns the bridge on automatically.
 */
export async function enableStrictGenerationVisibility(): Promise<StrictGenerationVisibilityCutover> {
  const { rows } = await sql`
    WITH policy AS MATERIALIZED (
      SELECT singleton, strict_generation_visibility, legacy_cutoff
      FROM hosted_backup_generation_visibility_policy
      WHERE singleton = true
      FOR UPDATE
    ),
    pending AS MATERIALIZED (
      SELECT COUNT(*)::int AS count
      FROM backup_versions v
      CROSS JOIN policy p
      WHERE v.deleted_at IS NULL
        AND v.legacy_unverified = true AND v.legacy_quarantined = false
        AND v.created_at < p.legacy_cutoff
    ),
    enabled AS (
      UPDATE hosted_backup_generation_visibility_policy p
      SET strict_generation_visibility = true
      FROM policy current
      WHERE p.singleton = current.singleton
        AND current.strict_generation_visibility = false
        AND (SELECT count FROM pending) = 0
      RETURNING 1
    )
    SELECT CASE
      WHEN (SELECT strict_generation_visibility FROM policy) THEN 'already_strict'
      WHEN EXISTS (SELECT 1 FROM enabled) THEN 'enabled'
      ELSE 'blocked_pending_legacy'
    END AS status
  `;
  return (rows[0] as { status: StrictGenerationVisibilityCutover }).status;
}

export async function insertBackup(params: { userId: string; name: string }): Promise<BackupRow> {
  const { rows } = await sql`
    INSERT INTO backups (user_id, name)
    VALUES (${params.userId}, ${params.name})
    RETURNING id, user_id, name, created_at, updated_at, deleted_at
  `;
  return rows[0] as BackupRow;
}

export async function listBackupsForUser(userId: string): Promise<BackupSummaryRow[]> {
  const { rows } = await sql`
    SELECT b.id, b.user_id, b.name, b.created_at, b.updated_at, b.deleted_at,
      (SELECT id FROM backup_versions
        WHERE backup_id = b.id AND deleted_at IS NULL
          AND ((committed_at IS NOT NULL AND legacy_unverified = false)
            OR (legacy_unverified = true AND legacy_quarantined = false
              AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
              AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
        ORDER BY created_at DESC LIMIT 1) AS latest_version_id,
      COALESCE((SELECT COUNT(*)::int FROM backup_versions
        WHERE backup_id = b.id AND deleted_at IS NULL
          AND ((committed_at IS NOT NULL AND legacy_unverified = false)
            OR (legacy_unverified = true AND legacy_quarantined = false
              AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
              AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))), 0) AS version_count,
      COALESCE((SELECT SUM(size_bytes)::bigint FROM backup_versions
        WHERE backup_id = b.id AND deleted_at IS NULL
          AND ((committed_at IS NOT NULL AND legacy_unverified = false)
            OR (legacy_unverified = true AND legacy_quarantined = false
              AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
              AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))), 0) AS total_size
    FROM backups b
    WHERE b.user_id = ${userId} AND b.deleted_at IS NULL
    ORDER BY b.updated_at DESC
  `;
  return rows as BackupSummaryRow[];
}

export async function getBackupOwned(userId: string, backupId: string): Promise<BackupRow | null> {
  const { rows } = await sql`
    SELECT id, user_id, name, created_at, updated_at, deleted_at
    FROM backups
    WHERE id = ${backupId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as BackupRow | undefined) ?? null;
}

export async function deleteBackupOwned(userId: string, backupId: string): Promise<number> {
  // Hard delete; FKs cascade to versions and chunks — which is exactly why
  // the R2 prefix must be enqueued in the SAME statement: the cascaded rows
  // carried the only object-key knowledge. The CTE enqueues if-and-only-if a
  // row was actually removed, so a failed delete can never schedule a purge
  // of live data, and a successful delete can never lose its prefix. Drained
  // by the backup-gc cron.
  const prefix = `users/${userId}/backups/${backupId}/`;
  const { rows } = await sql`
    WITH deleted AS (
      DELETE FROM backups
      WHERE id = ${backupId} AND user_id = ${userId}
      RETURNING id
    ),
    enqueued AS (
      INSERT INTO r2_purge_queue (r2_prefix)
      SELECT ${prefix} FROM deleted
      RETURNING 1
    )
    SELECT COUNT(*)::int AS removed FROM deleted
  `;
  return (rows[0] as { removed: number }).removed;
}

// Owner-scoped partial update of a backup's mutable metadata. Today only
// `name`; COALESCE leaves a field unchanged when its param is null, so adding
// a future field (description, tags, …) is a one-line extension here plus the
// column. Returns the updated row, or null when no owned, non-deleted row
// matched (not-found / not-owned are indistinguishable, per contract §7).
export async function updateBackupOwned(
  userId: string,
  backupId: string,
  fields: { name?: string | null }
): Promise<BackupRow | null> {
  const { rows } = await sql`
    UPDATE backups
    SET name = COALESCE(${fields.name ?? null}, name),
        updated_at = now()
    WHERE id = ${backupId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id, user_id, name, created_at, updated_at, deleted_at
  `;
  return (rows[0] as BackupRow | undefined) ?? null;
}

export async function listVersions(backupId: string): Promise<BackupVersionRow[]> {
  const { rows } = await sql`
    SELECT id, backup_id, created_at, size_bytes, manifest_size_bytes, manifest_object_key,
           manifest_sha256, chunk_count, deleted_at, committed_at, requires_commit, client_commit_required, legacy_unverified
    FROM backup_versions
    WHERE backup_id = ${backupId}
      AND deleted_at IS NULL
      AND ((committed_at IS NOT NULL AND legacy_unverified = false)
        OR (legacy_unverified = true AND legacy_quarantined = false
          AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
          AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
    ORDER BY created_at DESC
  `;
  return rows as BackupVersionRow[];
}

// Ownership-scoped single-version lookup for download URLs. It applies the
// same DB-governed visibility rule as listings, so a pending or post-cutoff
// unverified generation cannot be fetched by guessing its id.
export async function getVersionOwned(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<BackupVersionRow | null> {
  const { rows } = await sql`
    SELECT v.id, v.backup_id, v.created_at, v.size_bytes, v.manifest_size_bytes, v.manifest_object_key,
           v.manifest_sha256, v.chunk_count, v.deleted_at,
           v.committed_at, v.requires_commit, v.client_commit_required, v.legacy_unverified
    FROM backup_versions v
    JOIN backups b ON b.id = v.backup_id
    WHERE v.id = ${params.versionId}
      AND v.backup_id = ${params.backupId}
      AND b.user_id = ${params.userId}
      AND v.deleted_at IS NULL
      AND ((v.committed_at IS NOT NULL AND v.legacy_unverified = false)
        OR (v.legacy_unverified = true AND v.legacy_quarantined = false
          AND v.created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
          AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
      AND b.deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as BackupVersionRow | undefined) ?? null;
}

/** Pending-version lookup used only by publication and reconciliation. */
export async function getVersionForCommitOwned(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<BackupVersionRow | null> {
  const { rows } = await sql`
    SELECT v.id, v.backup_id, v.created_at, v.size_bytes, v.manifest_size_bytes,
           v.manifest_object_key, v.manifest_sha256, v.chunk_count, v.deleted_at,
           v.committed_at, v.requires_commit, v.client_commit_required, v.gc_reclaim_token,
           v.legacy_unverified
    FROM backup_versions v
    JOIN backups b ON b.id = v.backup_id
    WHERE v.id = ${params.versionId}
      AND v.backup_id = ${params.backupId}
      AND b.user_id = ${params.userId}
      AND v.deleted_at IS NULL
      AND b.deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as BackupVersionRow | undefined) ?? null;
}

export async function findVersionOperationOwned(params: {
  userId: string;
  backupId: string;
  operationId: string;
}): Promise<BackupVersionOperationRow | null> {
  const { rows } = await sql`
    SELECT user_id, backup_id, operation_id, version_id, manifest_size_bytes,
           manifest_sha256, chunk_metadata, committed_at
    FROM backup_version_operations
    WHERE user_id = ${params.userId}
      AND backup_id = ${params.backupId}
      AND operation_id = ${params.operationId}
    LIMIT 1
  `;
  return (rows[0] as BackupVersionOperationRow | undefined) ?? null;
}

/** Live-row lookup retained for GC/reconciliation callers. Create replay uses the durable ledger above. */
export async function findVersionByOperationOwned(params: {
  userId: string;
  backupId: string;
  operationId: string;
}): Promise<BackupVersionRow | null> {
  const { rows } = await sql`
    SELECT v.id, v.backup_id, v.created_at, v.size_bytes, v.manifest_size_bytes,
           v.manifest_object_key, v.manifest_sha256, v.chunk_count, v.deleted_at,
           v.committed_at, v.requires_commit, v.client_commit_required,
           v.client_operation_id, v.gc_reclaim_token, v.replay_fence_token, v.replay_fence_expires_at,
           v.legacy_unverified
    FROM backup_versions v
    JOIN backups b ON b.id = v.backup_id
    WHERE v.backup_id = ${params.backupId}
      AND b.user_id = ${params.userId}
      AND v.client_operation_id = ${params.operationId}
      AND v.deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as BackupVersionRow | undefined) ?? null;
}

/**
 * Atomically reserves a pending generation against GC for the full lifetime
 * of replacement upload URLs. The GC claim query observes the same expiry, so
 * there is no check-then-presign window in which it can reclaim the objects.
 */
export async function leaseVersionForReplayOwned(params: {
  userId: string;
  backupId: string;
  operationId: string;
  ttlSeconds: number;
}): Promise<BackupVersionRow | null> {
  const { rows } = await sql`
    WITH operation AS MATERIALIZED (
      SELECT version_id
      FROM backup_version_operations
      WHERE user_id = ${params.userId}
        AND backup_id = ${params.backupId}
        AND operation_id = ${params.operationId}
        AND committed_at IS NULL
    )
    UPDATE backup_versions v
    SET replay_fence_token = gen_random_uuid(),
        replay_fence_expires_at = now() + (interval '1 second' * ${params.ttlSeconds})
    FROM operation o, backups b
    WHERE v.id = o.version_id
      AND v.backup_id = ${params.backupId}
      AND b.id = v.backup_id
      AND b.user_id = ${params.userId}
      AND b.deleted_at IS NULL
      AND v.deleted_at IS NULL
      AND v.committed_at IS NULL
      AND v.gc_reclaim_token IS NULL
    RETURNING v.id, v.backup_id, v.created_at, v.size_bytes, v.manifest_size_bytes,
              v.manifest_object_key, v.manifest_sha256, v.chunk_count, v.deleted_at,
              v.committed_at, v.requires_commit, v.client_commit_required,
              v.client_operation_id, v.gc_reclaim_token, v.replay_fence_token, v.replay_fence_expires_at,
              v.legacy_unverified
  `;
  return (rows[0] as BackupVersionRow | undefined) ?? null;
}

/**
 * Replaces the provisional replay fence with the actual latest signed URL
 * expiry. The token prevents a delayed signer from reviving a row that GC has
 * already claimed.
 */
export async function finalizeReplayFenceOwned(params: {
  userId: string;
  backupId: string;
  versionId: string;
  replayFenceToken: string;
  expiresAt: Date;
}): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE backup_versions v
    SET replay_fence_expires_at = GREATEST(
      COALESCE(v.replay_fence_expires_at, '-infinity'::timestamptz),
      ${params.expiresAt.toISOString()}::timestamptz
    )
    FROM backups b
    WHERE v.id = ${params.versionId}
      AND v.backup_id = ${params.backupId}
      AND b.id = v.backup_id
      AND b.user_id = ${params.userId}
      AND b.deleted_at IS NULL
      AND v.deleted_at IS NULL
      AND v.committed_at IS NULL
      AND v.gc_reclaim_token IS NULL
      AND v.replay_fence_token = ${params.replayFenceToken}::uuid
  `;
  return (rowCount ?? 0) > 0;
}

export async function listChunksForVersion(versionId: string): Promise<BackupChunkRow[]> {
  const { rows } = await sql`
    SELECT version_id, chunk_index, object_key, size_bytes, sha256
    FROM backup_chunks
    WHERE version_id = ${versionId}
    ORDER BY chunk_index ASC
  `;
  return rows as BackupChunkRow[];
}

export async function softDeleteVersionOwned(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<number> {
  const { rowCount } = await sql`
    UPDATE backup_versions SET deleted_at = now()
    WHERE id = ${params.versionId}
      AND backup_id = ${params.backupId}
      AND deleted_at IS NULL
      AND backup_id IN (SELECT id FROM backups WHERE user_id = ${params.userId})
  `;
  return rowCount ?? 0;
}

export async function sumActiveStorageForUser(userId: string): Promise<number> {
  const { rows } = await sql`
    SELECT COALESCE(SUM(v.size_bytes)::bigint, 0)::text AS total
    FROM backup_versions v
    JOIN backups b ON b.id = v.backup_id
    WHERE b.user_id = ${userId}
      AND v.deleted_at IS NULL
      AND ((v.committed_at IS NOT NULL AND v.legacy_unverified = false)
        OR (v.legacy_unverified = true AND v.legacy_quarantined = false
          AND v.created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
          AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
      AND b.deleted_at IS NULL
  `;
  const total = (rows[0] as { total: string }).total;
  return Number(total);
}

/**
 * Per-user backup storage stats for the account/me surface (issue #59):
 * total active bytes, active version count, and the most recent version's
 * createdAt. One round-trip; excludes soft-deleted versions and backups
 * (matches sumActiveStorageForUser). `lastBackupAt` is null when the user has
 * no active versions.
 */
export async function getUserBackupStats(
  userId: string
): Promise<{ usedBytes: number; versionCount: number; lastBackupAt: string | null }> {
  const { rows } = await sql`
    SELECT
      COALESCE(SUM(v.size_bytes)::bigint, 0)::text AS used_bytes,
      COUNT(v.id)::int                             AS version_count,
      MAX(v.created_at)                            AS last_backup_at
    FROM backup_versions v
    JOIN backups b ON b.id = v.backup_id
    WHERE b.user_id = ${userId}
      AND v.deleted_at IS NULL
      AND ((v.committed_at IS NOT NULL AND v.legacy_unverified = false)
        OR (v.legacy_unverified = true AND v.legacy_quarantined = false
          AND v.created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
          AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
      AND b.deleted_at IS NULL
  `;
  const row = rows[0] as {
    used_bytes: string;
    version_count: number;
    last_backup_at: string | null;
  };
  return {
    usedBytes: Number(row.used_bytes),
    versionCount: Number(row.version_count),
    lastBackupAt: row.last_backup_at,
  };
}

export async function insertVersionWithChunks(params: {
  userId: string;
  quotaBytes: number;
  versionId: string;
  backupId: string;
  sizeBytes: number;
  manifestSizeBytes: number;
  manifestObjectKey: string;
  manifestSha256: Uint8Array;
  chunkCount: number;
  /**
   * All new rows remain pending. Older clients are published only by the
   * bounded R2 reconciliation pass after their complete object set is proven.
   */
  requiresCommit?: boolean;
  clientCommitRequired?: boolean;
  clientOperationId?: string | null;
  operationChunkMetadata?: Array<{ index: number; encryptedSize: number; sha256: string }>;
  chunks: Array<{
    index: number;
    objectKey: string;
    sizeBytes: number;
    sha256: Uint8Array;
  }>;
}): Promise<BackupVersionRow | null> {
  const indices = params.chunks.map((c) => c.index);
  const objectKeys = params.chunks.map((c) => c.objectKey);
  const sizes = params.chunks.map((c) => c.sizeBytes);
  const sha256s = params.chunks.map((c) => Buffer.from(c.sha256).toString("hex"));
  const operationChunkMetadata = JSON.stringify(params.operationChunkMetadata ?? []);

  // Single statement with CTEs: the version insert, the chunks insert, and
  // the parent-backup updated_at touch all run atomically.
  const { rows } = await sql`
    WITH locked AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${params.userId}, 0))
    ),
    owner AS (
      SELECT b.id FROM backups b CROSS JOIN locked
      WHERE b.id = ${params.backupId} AND b.user_id = ${params.userId} AND b.deleted_at IS NULL
    ),
    reserved AS (
      SELECT COALESCE(SUM(v.size_bytes), 0)::bigint AS bytes
      FROM backup_versions v
      JOIN backups b ON b.id = v.backup_id
      CROSS JOIN locked
      WHERE b.user_id = ${params.userId} AND b.deleted_at IS NULL AND v.deleted_at IS NULL
        AND v.legacy_quarantined = false
    ),
    reserved_operation AS (
      INSERT INTO backup_version_operations (
        user_id, backup_id, operation_id, version_id, manifest_size_bytes,
        manifest_sha256, chunk_metadata
      )
      SELECT
        ${params.userId}, ${params.backupId}, ${params.clientOperationId ?? null},
        ${params.versionId}, ${params.manifestSizeBytes}, ${Buffer.from(params.manifestSha256)},
        ${operationChunkMetadata}::jsonb
      FROM owner CROSS JOIN reserved
      WHERE ${params.clientOperationId ?? null}::text IS NOT NULL
        AND reserved.bytes + ${params.sizeBytes} <= ${params.quotaBytes}
      ON CONFLICT (backup_id, operation_id) DO NOTHING
      RETURNING version_id
    ),
    inserted_version AS (
      INSERT INTO backup_versions (
        id, backup_id, size_bytes, manifest_size_bytes, manifest_object_key, manifest_sha256,
        chunk_count, requires_commit, client_commit_required, client_operation_id
      ) SELECT
        ${params.versionId},
        ${params.backupId},
        ${params.sizeBytes},
        ${params.manifestSizeBytes},
        ${params.manifestObjectKey},
        ${Buffer.from(params.manifestSha256)},
        ${params.chunkCount},
        ${params.requiresCommit ?? true},
        ${params.clientCommitRequired ?? true},
        ${params.clientOperationId ?? null}
      FROM owner CROSS JOIN reserved
      WHERE reserved.bytes + ${params.sizeBytes} <= ${params.quotaBytes}
        AND (${params.clientOperationId ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM reserved_operation))
      ON CONFLICT (backup_id, client_operation_id)
        WHERE client_operation_id IS NOT NULL AND deleted_at IS NULL DO NOTHING
      RETURNING id, backup_id, created_at, size_bytes, manifest_size_bytes, manifest_object_key,
                manifest_sha256, chunk_count, deleted_at,
                committed_at, requires_commit, client_commit_required, gc_reclaim_token,
                legacy_unverified
    ),
    inserted_chunks AS (
      INSERT INTO backup_chunks (version_id, chunk_index, object_key, size_bytes, sha256)
      SELECT
        iv.id,
        ci.idx,
        ci.key,
        ci.size,
        decode(ci.hash, 'hex')
      FROM inserted_version iv
      CROSS JOIN unnest(
        ${indices}::int[],
        ${objectKeys}::text[],
        ${sizes}::int[],
        ${sha256s}::text[]
      ) AS ci(idx, key, size, hash)
      RETURNING 1
    ),
    touched_backup AS (
      UPDATE backups SET updated_at = now()
      WHERE id = ${params.backupId}
      RETURNING 1
    )
    SELECT id, backup_id, created_at, size_bytes, manifest_size_bytes, manifest_object_key,
           manifest_sha256, chunk_count, deleted_at, committed_at, requires_commit,
           client_commit_required, gc_reclaim_token, legacy_unverified
    FROM inserted_version
  `;
  return (rows[0] as BackupVersionRow | undefined) ?? null;
}

/**
 * Stamp a version committed and report whether this call is the one that did
 * it. Ownership is enforced in the same statement — a cross-user or unknown
 * id yields no row, which the caller turns into 404 (contract §7: not-found
 * and not-owned are indistinguishable).
 *
 * Idempotent by construction: the UPDATE only fires for a row whose
 * `committed_at` is still NULL, and the outer SELECT reads the pre-image, so
 * a replay returns the ORIGINAL timestamp with `already_committed = true`
 * rather than sliding the commit time forward. The caller uses that flag to
 * skip re-running the retention prune.
 */
export async function commitVersion(params: {
  userId: string;
  backupId: string;
  versionId: string;
  retain?: number;
}): Promise<{ committedAt: string; alreadyCommitted: boolean; prunedVersions: number } | null> {
  const { rows } = await sql`
    WITH target AS MATERIALIZED (
      SELECT v.id, v.committed_at
      FROM backup_versions v
      JOIN backups b ON b.id = v.backup_id
      WHERE v.id = ${params.versionId}
        AND v.backup_id = ${params.backupId}
        AND b.user_id = ${params.userId}
        AND v.deleted_at IS NULL
        AND b.deleted_at IS NULL
        AND v.gc_reclaim_token IS NULL
    ),
    stamped AS (
      UPDATE backup_versions
      SET committed_at = now()
      WHERE id IN (SELECT id FROM target WHERE committed_at IS NULL)
        AND committed_at IS NULL
      RETURNING id, committed_at
    ),
    marked_operation AS (
      UPDATE backup_version_operations o
      SET committed_at = s.committed_at
      FROM stamped s
      WHERE o.version_id = s.id AND o.committed_at IS NULL
      RETURNING o.version_id
    ),
    pruned AS (
      UPDATE backup_versions
      SET deleted_at = now()
      WHERE backup_id = ${params.backupId}
        AND deleted_at IS NULL
        AND ((committed_at IS NOT NULL AND legacy_unverified = false)
          OR (legacy_unverified = true AND legacy_quarantined = false
            AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
            AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
        AND id NOT IN (
          SELECT id FROM backup_versions
          WHERE backup_id = ${params.backupId}
            AND deleted_at IS NULL
            AND ((committed_at IS NOT NULL AND legacy_unverified = false)
              OR (legacy_unverified = true AND legacy_quarantined = false
                AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
                AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
          ORDER BY created_at DESC
          LIMIT ${params.retain ?? 5}
        )
        AND EXISTS (SELECT 1 FROM stamped)
      RETURNING id
    ),
    touched_backup AS (
      UPDATE backups SET updated_at = now()
      WHERE id = ${params.backupId}
        AND EXISTS (SELECT 1 FROM target)
      RETURNING 1
    )
    SELECT
      COALESCE(t.committed_at, s.committed_at) AS committed_at,
      (t.committed_at IS NOT NULL)             AS already_committed,
      (SELECT COUNT(*)::int FROM pruned)       AS pruned_versions
    FROM target t
    LEFT JOIN stamped s ON s.id = t.id
  `;
  const row = rows[0] as
    | { committed_at: string; already_committed: boolean; pruned_versions: number }
    | undefined;
  if (!row) return null;
  return {
    committedAt: row.committed_at,
    alreadyCommitted: row.already_committed,
    prunedVersions: row.pruned_versions,
  };
}

/**
 * Enforce the §8 retention cap. Operates strictly on VISIBLE versions: an
 * uncommitted row neither occupies a retention slot nor gets soft-deleted
 * here (backup-gc reclaims those instead). That is what stops a failed push
 * from evicting a good older version — the phantom never enters the ranking.
 */
export async function softDeleteVersionsBeyondRetention(params: {
  backupId: string;
  retain: number;
}): Promise<number> {
  const { rowCount } = await sql`
    UPDATE backup_versions
    SET deleted_at = now()
    WHERE backup_id = ${params.backupId}
      AND deleted_at IS NULL
      AND ((committed_at IS NOT NULL AND legacy_unverified = false)
        OR (legacy_unverified = true AND legacy_quarantined = false
          AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
          AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
      AND id NOT IN (
        SELECT id FROM backup_versions
        WHERE backup_id = ${params.backupId}
          AND deleted_at IS NULL
          AND ((committed_at IS NOT NULL AND legacy_unverified = false)
            OR (legacy_unverified = true AND legacy_quarantined = false
              AND created_at < (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true)
              AND NOT (SELECT strict_generation_visibility FROM hosted_backup_generation_visibility_policy WHERE singleton = true)))
        ORDER BY created_at DESC
        LIMIT ${params.retain}
      )
  `;
  return rowCount ?? 0;
}

// --- Account deletion ---

export async function insertAccountDeletionAudit(params: {
  userIdHash: Uint8Array;
  reason: string;
}): Promise<void> {
  await sql`
    INSERT INTO audit_log_account_deletions (user_id_hash, reason)
    VALUES (${Buffer.from(params.userIdHash)}, ${params.reason})
  `;
}

export async function enqueuePaddleCancellationTombstone(params: {
  userIdHash: Uint8Array;
  paddleSubscriptionId: string;
}): Promise<string> {
  const { rows } = await sql`
    INSERT INTO paddle_cancellation_tombstones (user_id_hash, paddle_subscription_id)
    VALUES (${Buffer.from(params.userIdHash)}, ${params.paddleSubscriptionId})
    ON CONFLICT (paddle_subscription_id) DO UPDATE
    SET paddle_subscription_id = EXCLUDED.paddle_subscription_id
    RETURNING id
  `;
  const row = rows[0] as { id: string } | undefined;
  if (!row) throw new Error("PADDLE_CANCELLATION_TOMBSTONE_MISSING");
  return row.id;
}

export async function findPendingPaddleCancellations(
  limit: number
): Promise<Array<{ id: string; paddle_subscription_id: string }>> {
  const { rows } = await sql`
    WITH candidates AS (
      SELECT id FROM paddle_cancellation_tombstones
      WHERE cancelled_at IS NULL
        AND next_attempt_at <= now()
        AND (processing_started_at IS NULL OR processing_started_at < now() - interval '15 minutes')
      ORDER BY created_at ASC LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE paddle_cancellation_tombstones t SET processing_started_at = now()
    FROM candidates c WHERE t.id = c.id
    RETURNING t.id, t.paddle_subscription_id
  `;
  return rows as Array<{ id: string; paddle_subscription_id: string }>;
}

export async function markPaddleCancellationAttempt(
  id: string,
  cancelled: boolean,
  error?: string
): Promise<{ attentionRequired: boolean }> {
  const { rows } = await sql`
    UPDATE paddle_cancellation_tombstones
    SET attempts = attempts + 1,
        cancelled_at = CASE WHEN ${cancelled} THEN now() ELSE cancelled_at END,
        processing_started_at = NULL,
        next_attempt_at = CASE
          WHEN ${cancelled} THEN now()
          ELSE now() + LEAST(
            interval '24 hours',
            interval '5 minutes' * power(2, LEAST(attempts + 1, 8))
          )
        END,
        attention_required_at = CASE
          WHEN NOT ${cancelled} AND attempts + 1 >= 10
          THEN COALESCE(attention_required_at, now())
          ELSE attention_required_at
        END,
        last_error = ${error?.slice(0, 1000) ?? null}
    WHERE id = ${id} AND cancelled_at IS NULL
    RETURNING attention_required_at IS NOT NULL AS attention_required
  `;
  return {
    attentionRequired: Boolean(
      (rows[0] as { attention_required?: boolean } | undefined)?.attention_required
    ),
  };
}

export async function getPaddleCancellationAttentionCount(): Promise<number> {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS attention_count
    FROM paddle_cancellation_tombstones
    WHERE cancelled_at IS NULL AND attention_required_at IS NOT NULL
  `;
  return Number((rows[0] as { attention_count?: number } | undefined)?.attention_count ?? 0);
}

export async function deleteUserCascade(userId: string): Promise<number> {
  // FKs cascade across auth_credentials, refresh_tokens, subscriptions,
  // backups (and via backups, backup_versions and backup_chunks). The user's
  // R2 prefix is enqueued for purge in the same statement: the audit log only
  // keeps sha256(userId), so once this row is gone the prefix cannot be
  // reconstructed. Enqueued if-and-only-if the user row was removed; the
  // backup-gc cron drains the queue (the /account UI promises purge within
  // 24 hours).
  const prefix = `users/${userId}/`;
  const { rows } = await sql`
    WITH deleted AS (
      DELETE FROM users WHERE id = ${userId}
      RETURNING id
    ),
    enqueued AS (
      INSERT INTO r2_purge_queue (r2_prefix)
      SELECT ${prefix} FROM deleted
      RETURNING 1
    )
    SELECT COUNT(*)::int AS removed FROM deleted
  `;
  return (rows[0] as { removed: number }).removed;
}

// --- Account portal: cookie sessions + redeemed-jti ledger ---

export async function insertAccountSession(params: {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}): Promise<void> {
  await sql`
    INSERT INTO account_sessions (session_id, user_id, expires_at)
    VALUES (${params.sessionId}, ${params.userId}, ${params.expiresAt.toISOString()})
  `;
}

export async function findAccountSession(
  sessionId: string
): Promise<{ userId: string; expiresAt: string } | null> {
  const { rows } = await sql`
    SELECT user_id, expires_at FROM account_sessions
    WHERE session_id = ${sessionId} AND expires_at > now()
    LIMIT 1
  `;
  const row = rows[0] as { user_id: string; expires_at: string } | undefined;
  if (!row) return null;
  return { userId: row.user_id, expiresAt: row.expires_at };
}

export async function deleteAccountSession(sessionId: string): Promise<void> {
  await sql`DELETE FROM account_sessions WHERE session_id = ${sessionId}`;
}

/**
 * Mark a browser-session JWT as redeemed. Returns true if this is the first
 * time the jti is being burned; false if it had already been redeemed (the
 * caller must reject the request to prevent URL replay).
 */
export async function burnBrowserSessionJti(jti: string): Promise<boolean> {
  const { rowCount } = await sql`
    INSERT INTO redeemed_browser_session_jtis (jti)
    VALUES (${jti})
    ON CONFLICT (jti) DO NOTHING
  `;
  return (rowCount ?? 0) > 0;
}

// --- backup-gc cron: expired soft-deleted versions (Pass A) ---

export type ExpiredVersionRow = {
  id: string;
  manifest_object_key: string;
};

export async function findExpiredDeletedVersions(limit: number): Promise<ExpiredVersionRow[]> {
  const { rows } = await sql`
    SELECT id, manifest_object_key
    FROM backup_versions
    WHERE deleted_at < now() - interval '7 days'
    ORDER BY deleted_at ASC
    LIMIT ${limit}
  `;
  return rows as ExpiredVersionRow[];
}

export async function hardDeleteVersion(versionId: string, reclaimToken?: string): Promise<number> {
  // Chunk rows cascade via the backup_chunks FK. Callers MUST have deleted
  // the R2 objects first — these rows carry the only object-key knowledge.
  const { rowCount } = await sql`
    DELETE FROM backup_versions WHERE id = ${versionId}
      AND (${reclaimToken ?? null}::uuid IS NULL OR gc_reclaim_token = ${reclaimToken ?? null}::uuid)
  `;
  return rowCount ?? 0;
}

// --- backup-gc cron: R2 purge queue (Pass B) ---

export type PurgeQueueRow = {
  id: string;
  r2_prefix: string;
};

/**
 * Pending purge prefixes, failure-aware: never-failed rows come first
 * (last_attempt_at NULL — includes large prefixes still draining within
 * budget, which keeps them at the front until done), failed rows rotate to
 * the back, and rows past `maxAttempts` are dead-lettered (left in the table
 * for inspection, no longer selected).
 */
export async function findPendingPurges(params: {
  limit: number;
  maxAttempts: number;
}): Promise<PurgeQueueRow[]> {
  const { rows } = await sql`
    SELECT id, r2_prefix
    FROM r2_purge_queue
    WHERE purged_at IS NULL AND attempts < ${params.maxAttempts}
    ORDER BY last_attempt_at ASC NULLS FIRST, enqueued_at ASC
    LIMIT ${params.limit}
  `;
  return rows as PurgeQueueRow[];
}

export async function markPurgeDone(id: string): Promise<void> {
  await sql`
    UPDATE r2_purge_queue SET purged_at = now() WHERE id = ${id}
  `;
}

export async function markPurgeAttemptFailed(params: { id: string; error: string }): Promise<void> {
  await sql`
    UPDATE r2_purge_queue
    SET attempts = attempts + 1,
        last_attempt_at = now(),
        last_error = ${params.error.slice(0, 1000)}
    WHERE id = ${params.id}
  `;
}

// --- backup-gc cron: abandoned-upload sweep (Pass C) ---

export type UncheckedManifestVersionRow = {
  id: string;
  manifest_object_key: string;
};

export async function findUncheckedManifestVersions(params: {
  olderThanHours: number;
  limit: number;
}): Promise<UncheckedManifestVersionRow[]> {
  const { rows } = await sql`
    SELECT id, manifest_object_key
    FROM backup_versions
    WHERE deleted_at IS NULL
      AND manifest_seen_at IS NULL
      AND created_at < now() - (interval '1 hour' * ${params.olderThanHours})
    ORDER BY created_at ASC
    LIMIT ${params.limit}
  `;
  return rows as UncheckedManifestVersionRow[];
}

export async function stampManifestSeen(versionId: string): Promise<void> {
  await sql`
    UPDATE backup_versions SET manifest_seen_at = now()
    WHERE id = ${versionId}
  `;
}

export async function softDeleteVersionById(versionId: string): Promise<void> {
  await sql`
    UPDATE backup_versions SET deleted_at = now()
    WHERE id = ${versionId} AND deleted_at IS NULL
  `;
}

// --- backup-gc cron: stale uncommitted versions (Pass F) ---

export type StaleUncommittedVersionRow = {
  id: string;
  manifest_object_key: string;
  gc_reclaim_token: string;
};

/**
 * Versions whose uploader promised a commit and never sent one. These never
 * became visible to anyone, so there is nothing to preserve for
 * accidental-deletion recovery — the caller deletes their R2 objects and hard
 * -deletes the rows, reclaiming the quota the abandoned push was holding.
 *
 * Distinct from the Pass C manifest sweep in two ways that matter: the window
 * is hours rather than 48, because a commit that has not arrived by then is
 * never arriving (presigned PUT URLs live 5 minutes), and the signal is our
 * own missing commit rather than a HEAD against R2 — so it also catches the
 * manifest-present/chunks-missing shape that a manifest HEAD can never see.
 */
export async function findStaleUncommittedVersions(params: {
  olderThanHours: number;
  limit: number;
}): Promise<StaleUncommittedVersionRow[]> {
  const { rows } = await sql`
    WITH candidates AS (
      SELECT id FROM backup_versions
      WHERE requires_commit = true
        AND (client_commit_required = true OR created_at >= (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true))
        AND committed_at IS NULL AND deleted_at IS NULL
        AND legacy_quarantined = false
        AND gc_reclaim_token IS NULL
        AND (replay_fence_expires_at IS NULL OR replay_fence_expires_at <= now())
        AND created_at < now() - (interval '1 hour' * ${params.olderThanHours})
      ORDER BY created_at ASC LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE backup_versions v
    SET gc_reclaim_token = gen_random_uuid(), gc_reclaim_started_at = now()
    FROM candidates c WHERE v.id = c.id
      AND v.committed_at IS NULL AND v.gc_reclaim_token IS NULL
      AND (v.replay_fence_expires_at IS NULL OR v.replay_fence_expires_at <= now())
    RETURNING v.id, v.manifest_object_key, v.gc_reclaim_token
  `;
  return rows as StaleUncommittedVersionRow[];
}

export async function releaseStaleUncommittedReclaim(
  versionId: string,
  reclaimToken: string
): Promise<void> {
  await sql`
    UPDATE backup_versions SET gc_reclaim_token = NULL, gc_reclaim_started_at = NULL
    WHERE id = ${versionId} AND gc_reclaim_token = ${reclaimToken}::uuid AND committed_at IS NULL
  `;
}

export type LegacyUnverifiedVersionRow = {
  id: string;
  backup_id: string;
  manifest_object_key: string;
  manifest_size_bytes: number;
};

/**
 * Historical rows and pre-commit-protocol clients are reconciled from R2
 * before publication. A short delay gives legacy clients a bounded upload
 * window while keeping incomplete generations out of every read surface.
 */
export async function findLegacyUnverifiedVersions(
  limit: number
): Promise<LegacyUnverifiedVersionRow[]> {
  const { rows } = await sql`
    SELECT id, backup_id, manifest_object_key, manifest_size_bytes
    FROM backup_versions
    WHERE deleted_at IS NULL
      AND committed_at IS NULL
      AND legacy_quarantined = false
      AND gc_reclaim_token IS NULL
      AND (legacy_unverified = true OR client_commit_required = false)
      AND created_at < now() - interval '1 hour'
    ORDER BY legacy_verification_attempts ASC, created_at ASC
    LIMIT ${limit}
  `;
  return rows as LegacyUnverifiedVersionRow[];
}

/**
 * Manual Release-A backfill uses newest-first batches so recent, useful
 * history recovers first. Its progress is still resumable because failures
 * increment `legacy_verification_attempts` and valid rows stop matching once
 * published.
 */
export async function findLegacyUnverifiedVersionsNewestFirst(
  limit: number
): Promise<LegacyUnverifiedVersionRow[]> {
  const { rows } = await sql`
    SELECT id, backup_id, manifest_object_key, manifest_size_bytes
    FROM backup_versions
    WHERE deleted_at IS NULL
      AND committed_at IS NULL
      AND legacy_quarantined = false
      AND gc_reclaim_token IS NULL
      AND (legacy_unverified = true OR client_commit_required = false)
      AND created_at < now() - interval '1 hour'
    ORDER BY created_at DESC, legacy_verification_attempts ASC
    LIMIT ${limit}
  `;
  return rows as LegacyUnverifiedVersionRow[];
}

export async function publishVerifiedLegacyVersion(versionId: string): Promise<boolean> {
  const { rows } = await sql`
    WITH published AS (
      UPDATE backup_versions
      SET legacy_unverified = false,
          legacy_verification_last_error = NULL,
          committed_at = now()
      WHERE id = ${versionId}
        AND deleted_at IS NULL
        AND committed_at IS NULL
        AND gc_reclaim_token IS NULL
        AND legacy_quarantined = false
        AND (legacy_unverified = true OR client_commit_required = false)
      RETURNING id, committed_at
    ),
    marked_operation AS (
      UPDATE backup_version_operations o
      SET committed_at = p.committed_at
      FROM published p
      WHERE o.version_id = p.id AND o.committed_at IS NULL
      RETURNING o.version_id
    )
    SELECT COUNT(*)::int AS published FROM published
  `;
  return (rows[0] as { published: number }).published > 0;
}

/**
 * Failed historical verification is recorded so corrupt object sets cannot
 * repeatedly consume the front of the bounded reconciliation queue. Rows stay
 * retained and untrusted; a future repair can still retry them.
 */
export async function markLegacyVerificationFailed(
  versionId: string,
  error: string
): Promise<void> {
  await sql`
    UPDATE backup_versions
    SET legacy_verification_attempts = legacy_verification_attempts + 1,
        legacy_verification_last_error = ${error.slice(0, 1000)}
    WHERE id = ${versionId}
      AND committed_at IS NULL
      AND legacy_quarantined = false
      AND (legacy_unverified = true OR client_commit_required = false)
  `;
}

/** Definitive R2 absence or wrong length: retain metadata but never trust it. */
export async function quarantineLegacyVersion(versionId: string, error: string): Promise<void> {
  await sql`
    UPDATE backup_versions
    SET legacy_quarantined = true,
        legacy_verification_attempts = legacy_verification_attempts + 1,
        legacy_verification_last_error = ${error.slice(0, 1000)}
    WHERE id = ${versionId} AND committed_at IS NULL AND legacy_quarantined = false
  `;
}

// --- backup-gc cron: post-cancellation data purge (Pass G) ---

/**
 * Completes the `cancelled → none` transition that contract §10 and the
 * public Terms both promise ("retained for 30 days to allow reactivation,
 * then permanently deleted"). `cancel_started_at` has been written by the
 * Paddle webhook since day one but was read by nothing; this is the query
 * that finally acts on it.
 *
 * Deliberately NOT `deleteUserCascade`: that is account deletion, and §10 is
 * explicit that the account survives the purge ("The user's account remains.
 * They can re-subscribe at any time"). What goes is the DATA — the `backups`
 * rows (versions and chunks cascade) plus the R2 prefix that carried their
 * objects. The exact deleted backup prefix is enqueued into the same
 * `r2_purge_queue` that backup and account deletion use, in the SAME
 * statement as the DELETE. A mutable user-wide prefix would let a delayed
 * queue item delete a newly re-subscribed user's fresh uploads. Pass B drains
 * only the immutable old backup prefixes.
 *
 * The status downgrade to `none` is what stops the row being reprocessed on
 * the next run, and it makes the read gate agree with reality rather than
 * relying only on the read-time cutoff in `getSubscriptionStatus`.
 */
export async function expireCancelledSubscriptions(params: {
  limit: number;
}): Promise<{ graceExpired: number; downgraded: number; prefixesEnqueued: number }> {
  const { rows } = await sql`
    WITH grace_expired AS MATERIALIZED (
      SELECT user_id, grace_started_at
      FROM subscriptions
      WHERE status = 'grace'
        AND grace_started_at IS NOT NULL
        AND grace_started_at < now() - (${GRACE_WINDOW_DAYS} || ' days')::interval
      ORDER BY grace_started_at ASC
      LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    ), transitioned AS (
      UPDATE subscriptions s
      SET status = 'cancelled',
          cancel_started_at = g.grace_started_at + (${GRACE_WINDOW_DAYS} || ' days')::interval,
          updated_at = now()
      FROM grace_expired g
      WHERE s.user_id = g.user_id AND s.status = 'grace'
      RETURNING s.user_id
    ), expired AS MATERIALIZED (
      SELECT user_id
      FROM subscriptions
      WHERE status = 'cancelled'
        AND cancel_started_at IS NOT NULL
        AND cancel_started_at < now() - (${CANCELLED_RETENTION_DAYS} || ' days')::interval
      ORDER BY cancel_started_at ASC
      LIMIT ${params.limit}
      FOR UPDATE SKIP LOCKED
    ),
    purged_backups AS (
      DELETE FROM backups
      WHERE user_id IN (SELECT user_id FROM expired)
      RETURNING user_id, id
    ),
    enqueued AS (
      INSERT INTO r2_purge_queue (r2_prefix)
      SELECT DISTINCT 'users/' || user_id || '/backups/' || id || '/'
      FROM purged_backups
      RETURNING 1
    ),
    downgraded AS (
      UPDATE subscriptions
      SET status = 'none', updated_at = now()
      WHERE user_id IN (SELECT user_id FROM expired)
        AND status = 'cancelled'
      RETURNING user_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM transitioned) AS grace_expired,
      (SELECT COUNT(*)::int FROM downgraded) AS downgraded,
      (SELECT COUNT(*)::int FROM enqueued)   AS prefixes_enqueued
  `;
  const row = rows[0] as { grace_expired: number; downgraded: number; prefixes_enqueued: number };
  return {
    graceExpired: row.grace_expired,
    downgraded: row.downgraded,
    prefixesEnqueued: row.prefixes_enqueued,
  };
}

// --- rate limiting (credential endpoints; pruned by backup-gc Pass D) ---

export async function countRateLimitEvents(params: {
  scope: string;
  key: string;
  windowSeconds: number;
}): Promise<number> {
  const { rows } = await sql`
    SELECT COUNT(*)::int AS n
    FROM rate_limit_events
    WHERE scope = ${params.scope}
      AND key = ${params.key}
      AND at > now() - (interval '1 second' * ${params.windowSeconds})
  `;
  return (rows[0] as { n: number }).n;
}

export async function insertRateLimitEvent(params: { scope: string; key: string }): Promise<void> {
  await sql`
    INSERT INTO rate_limit_events (scope, key)
    VALUES (${params.scope}, ${params.key})
  `;
}

export async function deleteRateLimitEventsBefore(hours: number): Promise<number> {
  const { rowCount } = await sql`
    DELETE FROM rate_limit_events
    WHERE at < now() - (interval '1 hour' * ${hours})
  `;
  return rowCount ?? 0;
}
