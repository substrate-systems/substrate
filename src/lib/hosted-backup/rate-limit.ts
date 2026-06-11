/**
 * App-level rate limiting for the credential endpoints (login / signup /
 * recover). DB-backed sliding-window counters in `rate_limit_events`
 * (migration 0016), pruned daily by the backup-gc cron.
 *
 * Semantics per endpoint (see the OpenSpec change
 * `harden-hosted-backup-operations`):
 *   - login:   failures only — a successful sign-in consumes no budget.
 *   - recover: failed proofs only.
 *   - signup:  every attempt (spam is the threat; recorded before body
 *     parsing so malformed floods self-limit too).
 *
 * The check-then-insert pair is not atomic; a concurrent burst can slightly
 * overshoot a cap. That is acceptable for abuse throttling — these limits
 * are an order-of-magnitude guard, not an exact quota.
 *
 * Keys are stored as sha256(scope:key) so the table never holds plaintext
 * emails or IPs (probe emails in particular may not even belong to users).
 */

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { errors } from './errors';
import { countRateLimitEvents, insertRateLimitEvent } from './db';

export type RateLimitRule = {
  scope: string;
  limit: number;
  windowSeconds: number;
};

export const RATE_LIMITS = {
  loginPerAccount: { scope: 'login:account', limit: 10, windowSeconds: 15 * 60 },
  loginPerIp: { scope: 'login:ip', limit: 30, windowSeconds: 15 * 60 },
  recoverPerAccount: { scope: 'recover:account', limit: 5, windowSeconds: 60 * 60 },
  recoverPerIp: { scope: 'recover:ip', limit: 5, windowSeconds: 60 * 60 },
  signupPerIp: { scope: 'signup:ip', limit: 10, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * First `x-forwarded-for` hop. Vercel OVERWRITES this header with the real
 * connecting IP (it does not append like a generic reverse proxy), so the
 * first hop is the trustworthy one on this platform. Returns `null` when no
 * IP is derivable (e.g. local dev) — per-IP limiting then fails OPEN for
 * that request rather than collapsing all header-less callers into one
 * shared bucket a single client could exhaust. Per-account limits still
 * apply regardless.
 */
export function clientIpFrom(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (!xff) return null;
  const first = xff.split(',')[0]?.trim();
  return first || null;
}

function hashedKey(rule: RateLimitRule, key: string): string {
  return createHash('sha256')
    .update(`${rule.scope}:${key}`, 'utf8')
    .digest('hex');
}

/**
 * Throws `RATE_LIMITED` (429) when `(rule, key)` has reached its window
 * limit. Call BEFORE the expensive work (DB lookups, Argon2 verification) so
 * a throttled caller costs nearly nothing.
 */
export async function enforceRateLimit(
  rule: RateLimitRule,
  key: string | null,
): Promise<void> {
  if (key === null) return; // no derivable key — fail open for this rule
  const n = await countRateLimitEvents({
    scope: rule.scope,
    key: hashedKey(rule, key),
    windowSeconds: rule.windowSeconds,
  });
  if (n >= rule.limit) {
    throw errors.rateLimited(
      `too many attempts; retry after ${Math.ceil(rule.windowSeconds / 60)} minutes`,
    );
  }
}

/**
 * Records one event against `(rule, key)`. Best-effort: a failure here is
 * logged but never masks the caller's own error path (if the DB is truly
 * down, `enforceRateLimit`'s count query fails loudly anyway).
 */
export async function recordRateLimitEvent(
  rule: RateLimitRule,
  key: string | null,
): Promise<void> {
  if (key === null) return;
  try {
    await insertRateLimitEvent({
      scope: rule.scope,
      key: hashedKey(rule, key),
    });
  } catch (err) {
    console.warn('[hosted-backup rate-limit] record failed:', err);
  }
}
