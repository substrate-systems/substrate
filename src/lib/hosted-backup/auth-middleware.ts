import type { NextRequest } from 'next/server';
import { verifyAccessToken } from './jwt';
import { errors } from './errors';
import { findUserById, getSubscriptionStatus } from './db';
import type { SubscriptionStatus } from './types';

export type AuthContext = {
  userId: string;
  subscriptionStatus: SubscriptionStatus;
  jti: string;
};

export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) throw errors.unauthenticated();
  const lower = header.toLowerCase();
  if (!lower.startsWith('bearer ')) {
    throw errors.unauthenticated('expected Bearer token');
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) throw errors.unauthenticated('empty Bearer token');
  const claims = await verifyAccessToken(token);
  return {
    userId: claims.userId,
    subscriptionStatus: claims.subscriptionStatus,
    jti: claims.jti,
  };
}

// Test-only bypass shared by `requireWriteAccess` and `requireReadAccess`.
// See the JSDoc on either gate function for semantics and threat model.
// Cache entry is keyed on the env-var source string so a changed env var is
// picked up on the next call without restart, and an invalid regex is only
// logged once per distinct source value.
type BypassCacheEntry = { source: string; regex: RegExp | null; warned: boolean };
let bypassCache: BypassCacheEntry | null = null;

function getTestEmailBypassPattern(): RegExp | null {
  const source = process.env.HOSTED_BACKUP_TEST_EMAIL_PATTERN ?? '';
  if (!source) return null;
  if (bypassCache && bypassCache.source === source) return bypassCache.regex;
  try {
    const regex = new RegExp(source);
    bypassCache = { source, regex, warned: false };
    return regex;
  } catch {
    if (!bypassCache || bypassCache.source !== source || !bypassCache.warned) {
      console.warn(
        `[hosted-backup] HOSTED_BACKUP_TEST_EMAIL_PATTERN is not a valid regex; bypass disabled`,
      );
    }
    bypassCache = { source, regex: null, warned: true };
    return null;
  }
}

/**
 * Auth + write-access gate. Re-reads subscription status from DB rather than
 * trusting the JWT claim (which is a hint with up to 15-min staleness per
 * contract §10). Allows only `active`.
 *
 * Test-only bypass: when `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is set to a
 * non-empty regex source, authenticated users whose stored email matches the
 * regex skip the subscription check. The same bypass is applied symmetrically
 * by the sibling `requireReadAccess` so a smoke account can complete the full
 * `signup → push → pull → byte-equal → delete` cycle. It MUST remain unset
 * in any deployment that is meant to enforce the paywall for all users.
 *
 * The bypass:
 *   - applies to both writes (this function) and reads (`requireReadAccess`).
 *   - requires both that the env var be set AND that the user's stored
 *     email match the compiled regex; an unset env var is a strict
 *     no-bypass state.
 *   - skips the live `subscriptions` DB read on match (the JWT-claim
 *     status is returned, already documented as a hint).
 *   - fails closed on an invalid regex source: bypass is disabled and a
 *     warning is logged, so misconfiguration cannot accidentally open the
 *     gate to every user.
 *   - logs a `console.warn` per request that takes the bypass, so the
 *     bypass usage is auditable.
 *
 * Threat model: the bypass is gated by two operator-controlled conditions —
 * the env var (set in Vercel project settings, requires admin access) and
 * the email regex (recommended pattern uses the RFC 2606 reserved
 * `example.com` domain, which no organic signup could match). See
 * `docs/runbooks/production-keys-and-storage.md` for the full discussion.
 */
export async function requireWriteAccess(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  const bypassRegex = getTestEmailBypassPattern();
  if (bypassRegex) {
    const user = await findUserById(ctx.userId);
    if (user && bypassRegex.test(user.email)) {
      console.warn(
        `[hosted-backup] subscription gate bypassed for test account user=${ctx.userId}`,
      );
      return ctx;
    }
  }
  const live = await getSubscriptionStatus(ctx.userId);
  if (live !== 'active') {
    throw errors.subscriptionRequired(
      live === 'none'
        ? 'an active subscription is required'
        : `writes are blocked while subscription is ${live}`,
    );
  }
  return { ...ctx, subscriptionStatus: live };
}

/**
 * Auth + read-access gate. Allows `active`, `grace`, `cancelled`. Blocks
 * `none`. Re-reads subscription status from DB.
 *
 * Honors the same `HOSTED_BACKUP_TEST_EMAIL_PATTERN` bypass as
 * `requireWriteAccess` — see that function's JSDoc for full semantics and
 * threat model. The bypass covers reads so a smoke-test account in
 * `status="none"` can complete the pull half of the round-trip
 * (`GET /api/backups`, `GET /api/backups/:id/versions`,
 * `POST /api/backups/:id/versions/:vid/download-urls`) which would
 * otherwise reject the smoke test before any data could be retrieved.
 */
export async function requireReadAccess(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  const bypassRegex = getTestEmailBypassPattern();
  if (bypassRegex) {
    const user = await findUserById(ctx.userId);
    if (user && bypassRegex.test(user.email)) {
      console.warn(
        `[hosted-backup] subscription gate bypassed for test account user=${ctx.userId}`,
      );
      return ctx;
    }
  }
  const live = await getSubscriptionStatus(ctx.userId);
  if (live === 'none') {
    throw errors.subscriptionRequired('no subscription on file');
  }
  return { ...ctx, subscriptionStatus: live };
}
