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

// DEBUG (revert after diagnosing prod bypass): module-load + per-request
// trace, split into short single-fact lines so each fits in the Vercel
// runtime-log table view.
{
  const _raw = process.env.HOSTED_BACKUP_TEST_EMAIL_PATTERN;
  let _compiles = false;
  let _matchesSample = false;
  let _compileError: string | null = null;
  if (_raw) {
    try {
      const _r = new RegExp(_raw);
      _compiles = true;
      _matchesSample = _r.test('smoketest+1@example.com');
    } catch (e) {
      _compileError = (e as Error).message;
    }
  }
  console.log('[hb-prod-debug] mod-load set:', _raw != null);
  console.log('[hb-prod-debug] mod-load len:', _raw?.length ?? 0);
  console.log('[hb-prod-debug] mod-load compiles:', _compiles);
  console.log('[hb-prod-debug] mod-load err:', _compileError);
  console.log('[hb-prod-debug] mod-load match:', _matchesSample);
  console.log('[hb-prod-debug] mod-load val:', _raw ?? '<unset>');
}

// Test-only bypass: see the JSDoc on `requireWriteAccess`. Cached entry is
// keyed on the env-var source string so a changed env var is picked up on
// the next call without restart, and an invalid regex is only logged once
// per distinct source value.
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
 * non-empty regex source, authenticated users whose email matches the regex
 * skip the subscription check. The bypass exists so the engine smoke test
 * can run end-to-end against production without going through Paddle
 * checkout for each disposable test account; it MUST remain unset in any
 * deployment that is meant to enforce the paywall for all users. The
 * bypass:
 *   - applies only to writes (this function); reads are unchanged.
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
 */
export async function requireWriteAccess(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  console.log('[hb-prod-debug] write enter user:', ctx.userId);
  const bypassRegex = getTestEmailBypassPattern();
  console.log('[hb-prod-debug] write regex-set:', bypassRegex != null);
  if (bypassRegex) {
    const user = await findUserById(ctx.userId);
    console.log('[hb-prod-debug] write user-found:', user != null);
    console.log('[hb-prod-debug] write email:', user?.email ?? '<none>');
    if (user && bypassRegex.test(user.email)) {
      console.log('[hb-prod-debug] write bypass: YES');
      console.warn(
        `[hosted-backup] subscription gate bypassed for test account user=${ctx.userId}`,
      );
      return ctx;
    }
    console.log('[hb-prod-debug] write bypass: NO');
  }
  const live = await getSubscriptionStatus(ctx.userId);
  console.log('[hb-prod-debug] write db-status:', live);
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
 * `none`. Re-reads subscription status from DB. The
 * `HOSTED_BACKUP_TEST_EMAIL_PATTERN` write-only bypass intentionally does
 * not apply here.
 */
export async function requireReadAccess(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  console.log('[hb-prod-debug] read enter user:', ctx.userId);
  const live = await getSubscriptionStatus(ctx.userId);
  console.log('[hb-prod-debug] read db-status:', live);
  if (live === 'none') {
    throw errors.subscriptionRequired('no subscription on file');
  }
  return { ...ctx, subscriptionStatus: live };
}
