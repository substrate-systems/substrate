/**
 * Neon Postgres queries for Hosted Backup auth.
 * Mirrors the lazy-singleton, template-literal pattern in `src/lib/license/db.ts`.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import type { KdfParams, SubscriptionStatus } from './types';

let _sql: NeonQueryFunction<false, true> | null = null;

function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): ReturnType<NeonQueryFunction<false, true>> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _sql = neon(url, { fullResults: true });
  }
  return _sql(strings, ...values);
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
export async function ensurePreAccount(
  email: string,
): Promise<{ userId: string; isNew: boolean }> {
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
    throw new Error(
      'ensurePreAccount: no row returned (user is soft-deleted?)',
    );
  }
  return { userId: row.id, isNew: row.is_new };
}

// Cheap presence check, used by the webhook + signup paths to distinguish a
// pre-account (no credentials yet) from a fully-credentialed user.
export async function userHasAuthCredentials(
  userId: string,
): Promise<boolean> {
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

export async function getAuthCredentials(
  userId: string,
): Promise<AuthCredentialsRow | null> {
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
    if (!url) throw new Error('DATABASE_URL is not set');
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
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
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
  tokenHash: Uint8Array,
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

export async function getChainRoot(
  chainId: string,
): Promise<RefreshTokenRow | null> {
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

export async function revokeAllRefreshChainsForUser(
  userId: string,
): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

// --- Signing keys ---

export async function getActiveAndRecentlyRetiredSigningKeys(): Promise<
  SigningKeyRow[]
> {
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
      ${params.algorithm ?? 'EdDSA'}
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
  updated_at: string;
};

// Past-due grace window per hosted-backup contract: Paddle's `past_due` keeps
// a user entitled for this many days, then they are cut off at read time. The
// stored row is left as `grace` so a late `subscription.activated` from
// Paddle can still recover the user without an extra state path.
export const GRACE_WINDOW_DAYS = 14;

export async function getSubscriptionStatus(
  userId: string,
): Promise<SubscriptionStatus> {
  const { rows } = await sql`
    SELECT
      CASE
        WHEN status = 'grace'
         AND grace_started_at IS NOT NULL
         AND grace_started_at < now() - (${GRACE_WINDOW_DAYS} || ' days')::interval
        THEN 'cancelled'
        ELSE status
      END AS effective_status
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  const row = rows[0] as { effective_status: SubscriptionStatus } | undefined;
  return row?.effective_status ?? 'none';
}

export type SubscriptionEntitlement = {
  effectiveStatus: SubscriptionStatus;
  storedStatus: SubscriptionStatus;
  plan: string | null;
  currentPeriodEnd: string | null;
  gracePeriodEndsAt: string | null;
  paddleSubscriptionId: string | null;
  paddleCustomerId: string | null;
  updatedAt: string | null;
};

/**
 * Returns the full debug view of a user's subscription, including the 14-day
 * grace-cutoff-adjusted effective status and a computed grace period end.
 * Used by `GET /api/account/me`.
 */
export async function getSubscriptionEntitlement(
  userId: string,
): Promise<SubscriptionEntitlement> {
  const { rows } = await sql`
    SELECT
      status,
      plan,
      current_period_end,
      grace_started_at,
      paddle_subscription_id,
      paddle_customer_id,
      updated_at,
      CASE
        WHEN status = 'grace'
         AND grace_started_at IS NOT NULL
         AND grace_started_at < now() - (${GRACE_WINDOW_DAYS} || ' days')::interval
        THEN 'cancelled'
        ELSE status
      END AS effective_status,
      CASE
        WHEN status = 'grace' AND grace_started_at IS NOT NULL
        THEN grace_started_at + (${GRACE_WINDOW_DAYS} || ' days')::interval
        ELSE NULL
      END AS grace_period_ends_at
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  const row = rows[0] as
    | {
        status: SubscriptionStatus;
        plan: string | null;
        current_period_end: string | null;
        grace_started_at: string | null;
        paddle_subscription_id: string | null;
        paddle_customer_id: string | null;
        updated_at: string;
        effective_status: SubscriptionStatus;
        grace_period_ends_at: string | null;
      }
    | undefined;
  if (!row) {
    return {
      effectiveStatus: 'none',
      storedStatus: 'none',
      plan: null,
      currentPeriodEnd: null,
      gracePeriodEndsAt: null,
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
    gracePeriodEndsAt: row.grace_period_ends_at,
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleCustomerId: row.paddle_customer_id,
    updatedAt: row.updated_at,
  };
}

export async function getSubscriptionByUserId(
  userId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await sql`
    SELECT user_id, paddle_subscription_id, paddle_customer_id, status, plan,
           grace_started_at, cancel_started_at, current_period_end, updated_at
    FROM subscriptions WHERE user_id = ${userId} LIMIT 1
  `;
  return (rows[0] as SubscriptionRow | undefined) ?? null;
}

export async function getSubscriptionByPaddleId(
  paddleSubscriptionId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await sql`
    SELECT user_id, paddle_subscription_id, paddle_customer_id, status, plan,
           grace_started_at, cancel_started_at, current_period_end, updated_at
    FROM subscriptions WHERE paddle_subscription_id = ${paddleSubscriptionId} LIMIT 1
  `;
  return (rows[0] as SubscriptionRow | undefined) ?? null;
}

export async function findUserIdByPaddleCustomerId(
  paddleCustomerId: string,
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
}): Promise<void> {
  await sql`
    INSERT INTO subscriptions (
      user_id, paddle_subscription_id, paddle_customer_id, status, plan,
      grace_started_at, cancel_started_at, current_period_end, updated_at
    ) VALUES (
      ${params.userId},
      ${params.paddleSubscriptionId},
      ${params.paddleCustomerId},
      ${params.status},
      ${params.plan ?? null},
      ${params.graceStartedAt?.toISOString() ?? null},
      ${params.cancelStartedAt?.toISOString() ?? null},
      ${params.currentPeriodEnd?.toISOString() ?? null},
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
      updated_at = now()
  `;
}

// --- Paddle webhook events (idempotency) ---

export async function recordPaddleEventIfFresh(params: {
  eventId: string;
  eventType: string;
}): Promise<boolean> {
  const { rowCount } = await sql`
    INSERT INTO paddle_webhook_events (event_id, event_type)
    VALUES (${params.eventId}, ${params.eventType})
    ON CONFLICT (event_id) DO NOTHING
  `;
  return (rowCount ?? 0) > 0;
}

export async function markPaddleEventProcessed(eventId: string): Promise<void> {
  await sql`
    UPDATE paddle_webhook_events SET processed_at = now() WHERE event_id = ${eventId}
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
  manifest_object_key: string;
  manifest_sha256: Uint8Array;
  chunk_count: number;
  deleted_at: string | null;
};

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

export async function insertBackup(params: {
  userId: string;
  name: string;
}): Promise<BackupRow> {
  const { rows } = await sql`
    INSERT INTO backups (user_id, name)
    VALUES (${params.userId}, ${params.name})
    RETURNING id, user_id, name, created_at, updated_at, deleted_at
  `;
  return rows[0] as BackupRow;
}

export async function listBackupsForUser(
  userId: string,
): Promise<BackupSummaryRow[]> {
  const { rows } = await sql`
    SELECT b.id, b.user_id, b.name, b.created_at, b.updated_at, b.deleted_at,
      (SELECT id FROM backup_versions
        WHERE backup_id = b.id AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1) AS latest_version_id,
      COALESCE((SELECT COUNT(*)::int FROM backup_versions
        WHERE backup_id = b.id AND deleted_at IS NULL), 0) AS version_count,
      COALESCE((SELECT SUM(size_bytes)::bigint FROM backup_versions
        WHERE backup_id = b.id AND deleted_at IS NULL), 0) AS total_size
    FROM backups b
    WHERE b.user_id = ${userId} AND b.deleted_at IS NULL
    ORDER BY b.updated_at DESC
  `;
  return rows as BackupSummaryRow[];
}

export async function getBackupOwned(
  userId: string,
  backupId: string,
): Promise<BackupRow | null> {
  const { rows } = await sql`
    SELECT id, user_id, name, created_at, updated_at, deleted_at
    FROM backups
    WHERE id = ${backupId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return (rows[0] as BackupRow | undefined) ?? null;
}

export async function deleteBackupOwned(
  userId: string,
  backupId: string,
): Promise<number> {
  // Hard delete; FKs cascade to versions and chunks.
  const { rowCount } = await sql`
    DELETE FROM backups
    WHERE id = ${backupId} AND user_id = ${userId}
  `;
  return rowCount ?? 0;
}

export async function listVersions(
  backupId: string,
): Promise<BackupVersionRow[]> {
  const { rows } = await sql`
    SELECT id, backup_id, created_at, size_bytes, manifest_object_key,
           manifest_sha256, chunk_count, deleted_at
    FROM backup_versions
    WHERE backup_id = ${backupId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  return rows as BackupVersionRow[];
}

export async function getVersionOwned(params: {
  userId: string;
  backupId: string;
  versionId: string;
}): Promise<BackupVersionRow | null> {
  const { rows } = await sql`
    SELECT v.id, v.backup_id, v.created_at, v.size_bytes, v.manifest_object_key,
           v.manifest_sha256, v.chunk_count, v.deleted_at
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

export async function listChunksForVersion(
  versionId: string,
): Promise<BackupChunkRow[]> {
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
      AND b.deleted_at IS NULL
  `;
  const total = (rows[0] as { total: string }).total;
  return Number(total);
}

export async function insertVersionWithChunks(params: {
  versionId: string;
  backupId: string;
  sizeBytes: number;
  manifestObjectKey: string;
  manifestSha256: Uint8Array;
  chunkCount: number;
  chunks: Array<{
    index: number;
    objectKey: string;
    sizeBytes: number;
    sha256: Uint8Array;
  }>;
}): Promise<BackupVersionRow> {
  const indices = params.chunks.map((c) => c.index);
  const objectKeys = params.chunks.map((c) => c.objectKey);
  const sizes = params.chunks.map((c) => c.sizeBytes);
  const sha256s = params.chunks.map((c) => Buffer.from(c.sha256).toString('hex'));

  // Single statement with CTEs: the version insert, the chunks insert, and
  // the parent-backup updated_at touch all run atomically.
  const { rows } = await sql`
    WITH inserted_version AS (
      INSERT INTO backup_versions (
        id, backup_id, size_bytes, manifest_object_key, manifest_sha256, chunk_count
      ) VALUES (
        ${params.versionId},
        ${params.backupId},
        ${params.sizeBytes},
        ${params.manifestObjectKey},
        ${Buffer.from(params.manifestSha256)},
        ${params.chunkCount}
      )
      RETURNING id, backup_id, created_at, size_bytes, manifest_object_key,
                manifest_sha256, chunk_count, deleted_at
    ),
    inserted_chunks AS (
      INSERT INTO backup_chunks (version_id, chunk_index, object_key, size_bytes, sha256)
      SELECT
        ${params.versionId},
        ci.idx,
        ci.key,
        ci.size,
        decode(ci.hash, 'hex')
      FROM unnest(
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
    SELECT id, backup_id, created_at, size_bytes, manifest_object_key,
           manifest_sha256, chunk_count, deleted_at
    FROM inserted_version
  `;
  return rows[0] as BackupVersionRow;
}

export async function softDeleteVersionsBeyondRetention(params: {
  backupId: string;
  retain: number;
}): Promise<number> {
  const { rowCount } = await sql`
    UPDATE backup_versions
    SET deleted_at = now()
    WHERE backup_id = ${params.backupId}
      AND deleted_at IS NULL
      AND id NOT IN (
        SELECT id FROM backup_versions
        WHERE backup_id = ${params.backupId} AND deleted_at IS NULL
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

export async function deleteUserCascade(userId: string): Promise<number> {
  // FKs cascade across auth_credentials, refresh_tokens, subscriptions,
  // backups (and via backups, backup_versions and backup_chunks).
  const { rowCount } = await sql`
    DELETE FROM users WHERE id = ${userId}
  `;
  return rowCount ?? 0;
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
  sessionId: string,
): Promise<{ userId: string; expiresAt: string } | null> {
  const { rows } = await sql`
    SELECT user_id, expires_at FROM account_sessions
    WHERE session_id = ${sessionId} AND expires_at > now()
    LIMIT 1
  `;
  const row = rows[0] as
    | { user_id: string; expires_at: string }
    | undefined;
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
