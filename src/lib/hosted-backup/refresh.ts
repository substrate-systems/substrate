/**
 * Opaque refresh-token issuance and rotation with reuse-detection.
 *
 * Tokens are 32 random bytes, base64url-encoded for transport. The DB stores
 * SHA-256(opaque) only — the opaque token never persists. Each chain has a
 * UUID `chain_id`. Rotation issues a child whose `parent_id` is the consumed
 * token. Reusing an already-revoked token revokes the entire chain.
 *
 * Contract §5: max chain lifetime 30 days.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as defaultStore from './db';
import type { RefreshTokenRow } from './db';
import { errors } from './errors';

const TOKEN_BYTES = 32;
const REFRESH_TTL_DAYS = 30;
const CHAIN_LIFETIME_MS = REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

// Test seam: tests inject an in-memory store so they don't need a real Neon
// connection. Production reads/writes through the real DB.
type Store = {
  insertRefreshToken: typeof defaultStore.insertRefreshToken;
  findRefreshTokenByHash: typeof defaultStore.findRefreshTokenByHash;
  getChainRoot: typeof defaultStore.getChainRoot;
  revokeRefreshToken: typeof defaultStore.revokeRefreshToken;
  revokeRefreshChain: typeof defaultStore.revokeRefreshChain;
};
let store: Store = defaultStore;
export function __setStore(s: Store | null): void {
  store = s ?? defaultStore;
}

function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function hashToken(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token).digest());
}

export type IssuedRefresh = {
  token: string;
  expiresAt: Date;
  row: RefreshTokenRow;
};

/** Issues a fresh chain-root refresh token (e.g. after signup or login step 2). */
export async function issueFreshChain(userId: string): Promise<IssuedRefresh> {
  const token = generateOpaqueToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + CHAIN_LIFETIME_MS);
  const row = await store.insertRefreshToken({
    userId,
    chainId: randomUUID(),
    parentId: null,
    tokenHash,
    expiresAt,
  });
  return { token, expiresAt, row };
}

/**
 * Rotates a presented refresh token. Returns a new token + the new row.
 * - If the presented token is unknown → REFRESH_INVALID
 * - If the chain has exceeded its 30-day lifetime → REFRESH_EXPIRED (chain revoked)
 * - If the presented token is already revoked → REFRESH_REUSE_DETECTED (chain revoked)
 * - Otherwise: revoke the presented token, issue a child, return.
 */
export async function rotateRefreshToken(
  presentedToken: string,
): Promise<IssuedRefresh> {
  const presentedHash = hashToken(presentedToken);
  const presented = await store.findRefreshTokenByHash(presentedHash);
  if (!presented) {
    throw errors.refreshInvalid();
  }

  const root =
    presented.parent_id === null
      ? presented
      : await store.getChainRoot(presented.chain_id);
  if (!root) {
    throw errors.refreshInvalid();
  }
  const rootIssuedAtMs = new Date(root.issued_at).getTime();
  if (Date.now() - rootIssuedAtMs > CHAIN_LIFETIME_MS) {
    await store.revokeRefreshChain(presented.chain_id);
    throw errors.refreshExpired();
  }

  if (presented.revoked_at !== null) {
    await store.revokeRefreshChain(presented.chain_id);
    throw errors.refreshReuseDetected();
  }

  await store.revokeRefreshToken(presented.id);
  const newToken = generateOpaqueToken();
  const newHash = hashToken(newToken);
  const newExpiresAt = new Date(rootIssuedAtMs + CHAIN_LIFETIME_MS);
  const row = await store.insertRefreshToken({
    userId: presented.user_id,
    chainId: presented.chain_id,
    parentId: presented.id,
    tokenHash: newHash,
    expiresAt: newExpiresAt,
  });
  return { token: newToken, expiresAt: newExpiresAt, row };
}

/** Idempotent logout: revokes the presented token if it exists and is unrevoked. */
export async function revokeRefreshTokenByValue(
  presentedToken: string,
): Promise<void> {
  const presentedHash = hashToken(presentedToken);
  const presented = await store.findRefreshTokenByHash(presentedHash);
  if (presented && presented.revoked_at === null) {
    await store.revokeRefreshToken(presented.id);
  }
}

export const _internal = {
  hashToken,
  generateOpaqueToken,
  TOKEN_BYTES,
  CHAIN_LIFETIME_MS,
  REFRESH_TTL_DAYS,
};
