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

// --- Subscription status (PR1 stub; PR3 replaces with real subscriptions table) ---

export async function getSubscriptionStatus(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  userId: string,
): Promise<SubscriptionStatus> {
  // TODO(PR3 add-hosted-backup-paddle-subscriptions): replace with
  // SELECT status FROM subscriptions WHERE user_id = $1
  return 'none';
}
