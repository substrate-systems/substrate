/**
 * Claim tokens — single-use bearer tokens that bind a pre-account `users`
 * row (no `auth_credentials`) to a future POST /api/auth/claim from the
 * GUI. Issued by the Paddle webhook when an unauthenticated marketing-page
 * checkout completes; consumed by the GUI's first-launch credential setup.
 *
 * Plaintext token lives ONLY in the email URL + the GUI paste-code. The
 * server stores sha256(token) as `token_hash` (primary key) — never the
 * plaintext. All reads/writes against `claim_tokens` live in this module so
 * the hash-not-plaintext invariant is local and auditable.
 */

import { createHash, randomBytes } from 'node:crypto';
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

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

// 30 days, per the spec. Plenty for a buyer to come back from a holiday.
export const CLAIM_TOKEN_TTL_DAYS = 30;
// Cron does at most 2 resends (24h + 7d) on top of the at-mint send.
export const CLAIM_RESEND_CAP = 2;
// User-triggered resend rate limit (POST /api/auth/claim/resend).
export const CLAIM_RESEND_RATE_LIMIT_SECONDS = 60;
// Founder digest threshold.
export const CLAIM_FOUNDER_ALERT_DAYS = 14;
// Cron resend cooldown — don't double-send within this window even if the
// last_sent_at row hasn't been bumped by a manual resend.
export const CLAIM_CRON_RESEND_COOLDOWN_HOURS = 23;

export type ClaimTokenRow = {
  token_hash: Uint8Array;
  user_id: string;
  email: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  resend_count: number;
  last_sent_at: string;
  founder_alerted_at: string | null;
};

export type ResendableClaim = {
  tokenHash: Uint8Array;
  userId: string;
  email: string;
  resendCount: number;
};

export type FounderAlertableClaim = {
  tokenHash: Uint8Array;
  userId: string;
  email: string;
  createdAt: string;
  paddleCustomerId: string | null;
};

function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

/**
 * Generate a fresh claim token, persist its hash, return both the plaintext
 * (for the email URL / GUI paste-code) and the hash (for callers that want
 * to reference the row).
 */
export async function mintClaimToken(params: {
  userId: string;
  email: string;
}): Promise<{ token: string; tokenHash: Uint8Array }> {
  const tokenBytes = randomBytes(32);
  // URL-safe base64 (no padding) — fits in an email link without escaping
  // and copies cleanly when the user pastes it into the GUI.
  const token = tokenBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const tokenHash = sha256(new Uint8Array(tokenBytes));
  const expiresAt = new Date(
    Date.now() + CLAIM_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  await sql`
    INSERT INTO claim_tokens (token_hash, user_id, email, expires_at)
    VALUES (
      ${Buffer.from(tokenHash)},
      ${params.userId},
      ${params.email},
      ${expiresAt.toISOString()}
    )
  `;
  return { token, tokenHash };
}

export type VerifyResult =
  | { kind: 'valid'; row: ClaimTokenRow }
  | { kind: 'invalid' }
  | { kind: 'expired'; row: ClaimTokenRow }
  | { kind: 'consumed'; row: ClaimTokenRow };

/**
 * Resolve a plaintext token to its row, classifying validity.
 *
 * Does NOT mutate the row. Callers that intend to claim follow up with
 * `consumeClaimToken(token)` for the atomic single-use update.
 */
export async function verifyClaimToken(token: string): Promise<VerifyResult> {
  const tokenBytes = decodeBase64UrlToken(token);
  if (!tokenBytes) return { kind: 'invalid' };
  const tokenHash = sha256(tokenBytes);
  const { rows } = await sql`
    SELECT token_hash, user_id, email, created_at, expires_at, consumed_at,
           resend_count, last_sent_at, founder_alerted_at
    FROM claim_tokens
    WHERE token_hash = ${Buffer.from(tokenHash)}
    LIMIT 1
  `;
  const row = rows[0] as ClaimTokenRow | undefined;
  if (!row) return { kind: 'invalid' };
  if (row.consumed_at) return { kind: 'consumed', row };
  if (new Date(row.expires_at) <= new Date()) {
    return { kind: 'expired', row };
  }
  return { kind: 'valid', row };
}

export type ConsumeResult =
  | { kind: 'consumed'; userId: string; email: string }
  | { kind: 'race' } // another caller consumed it between our SELECT and UPDATE
  | { kind: 'invalid' }
  | { kind: 'expired' };

/**
 * Atomically mark a claim token consumed. Returns the user_id/email for the
 * caller's downstream `insertAuthCredentials` + JWT issuance.
 */
export async function consumeClaimToken(
  token: string,
): Promise<ConsumeResult> {
  const tokenBytes = decodeBase64UrlToken(token);
  if (!tokenBytes) return { kind: 'invalid' };
  const tokenHash = sha256(tokenBytes);
  const { rows } = await sql`
    UPDATE claim_tokens
    SET consumed_at = now()
    WHERE token_hash = ${Buffer.from(tokenHash)}
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING user_id, email
  `;
  const row = rows[0] as { user_id: string; email: string } | undefined;
  if (row) return { kind: 'consumed', userId: row.user_id, email: row.email };
  // Distinguish why the UPDATE matched nothing.
  const verify = await verifyClaimToken(token);
  if (verify.kind === 'invalid') return { kind: 'invalid' };
  if (verify.kind === 'expired') return { kind: 'expired' };
  if (verify.kind === 'consumed') return { kind: 'race' };
  // Should be unreachable — verify said 'valid' but the UPDATE matched
  // nothing, which means the row was deleted between our two queries.
  return { kind: 'invalid' };
}

/**
 * Bump `last_sent_at` + `resend_count` after a user-triggered resend, with
 * the 60-second rate limit baked into the WHERE clause. Returns true on
 * success, false on rate-limit hit.
 */
export async function bumpClaimResend(
  tokenHash: Uint8Array,
): Promise<boolean> {
  const { rowCount } = await sql`
    UPDATE claim_tokens
    SET resend_count = resend_count + 1,
        last_sent_at = now()
    WHERE token_hash = ${Buffer.from(tokenHash)}
      AND consumed_at IS NULL
      AND last_sent_at < now() - (${CLAIM_RESEND_RATE_LIMIT_SECONDS} || ' seconds')::interval
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * Cron-side helper: rows the cron should resend now. Caller iterates and
 * calls `markCronResent(tokenHash)` after sending the email.
 */
export async function findResendableClaims(): Promise<ResendableClaim[]> {
  const { rows } = await sql`
    SELECT token_hash, user_id, email, resend_count
    FROM claim_tokens
    WHERE consumed_at IS NULL
      AND expires_at > now()
      AND resend_count < ${CLAIM_RESEND_CAP}
      AND last_sent_at < now() - (${CLAIM_CRON_RESEND_COOLDOWN_HOURS} || ' hours')::interval
  `;
  return (rows as Array<{
    token_hash: Uint8Array;
    user_id: string;
    email: string;
    resend_count: number;
  }>).map((r) => ({
    tokenHash: r.token_hash,
    userId: r.user_id,
    email: r.email,
    resendCount: r.resend_count,
  }));
}

export async function markCronResent(tokenHash: Uint8Array): Promise<void> {
  await sql`
    UPDATE claim_tokens
    SET resend_count = resend_count + 1,
        last_sent_at = now()
    WHERE token_hash = ${Buffer.from(tokenHash)}
      AND consumed_at IS NULL
  `;
}

/**
 * Rows that have been unclaimed for ≥14 days and have not yet been included
 * in a founder digest. The 14-day threshold is read from
 * CLAIM_FOUNDER_ALERT_DAYS. Joins through subscriptions for paddle_customer_id.
 */
export async function findFounderAlertableClaims(): Promise<
  FounderAlertableClaim[]
> {
  const { rows } = await sql`
    SELECT
      ct.token_hash,
      ct.user_id,
      ct.email,
      ct.created_at,
      s.paddle_customer_id
    FROM claim_tokens ct
    LEFT JOIN subscriptions s ON s.user_id = ct.user_id
    WHERE ct.consumed_at IS NULL
      AND ct.founder_alerted_at IS NULL
      AND ct.created_at < now() - (${CLAIM_FOUNDER_ALERT_DAYS} || ' days')::interval
  `;
  return (rows as Array<{
    token_hash: Uint8Array;
    user_id: string;
    email: string;
    created_at: string;
    paddle_customer_id: string | null;
  }>).map((r) => ({
    tokenHash: r.token_hash,
    userId: r.user_id,
    email: r.email,
    createdAt: r.created_at,
    paddleCustomerId: r.paddle_customer_id,
  }));
}

export async function markFounderAlerted(
  tokenHashes: Uint8Array[],
): Promise<void> {
  if (tokenHashes.length === 0) return;
  // Neon serverless doesn't expand IN $1 with arrays — issue one update per
  // row. N is small (digest list capped by the 14d window).
  for (const hash of tokenHashes) {
    await sql`
      UPDATE claim_tokens
      SET founder_alerted_at = now()
      WHERE token_hash = ${Buffer.from(hash)}
        AND founder_alerted_at IS NULL
    `;
  }
}

function decodeBase64UrlToken(token: string): Uint8Array | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  // Reverse the URL-safe transform from mintClaimToken.
  const normalized = token.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  try {
    const buf = Buffer.from(padded, 'base64');
    if (buf.length !== 32) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// Test seam.
export const _internal = { sha256, decodeBase64UrlToken };
