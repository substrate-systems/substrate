/**
 * Cookie-based auth for the substrate `/account` portal. The JWT handoff
 * (`/api/auth/browser-session` + `/redeem`) sets `endstate_account_session`;
 * everything else on `/account` and its POSTs uses this gate to resolve the
 * cookie back to a `userId`.
 *
 * See `browser-session.ts` for the redeem flow that issues the cookie.
 */

import type { ReadonlyRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';
import { errors } from './errors';
import {
  ACCOUNT_SESSION_COOKIE,
  resolveAccountSession,
} from './browser-session';

export type AccountAuthContext = {
  userId: string;
  cookieSessionId: string;
};

/**
 * Resolve the `endstate_account_session` cookie to a `userId`. Throws
 * `accountSessionInvalid` if missing, malformed, or expired.
 */
export async function requireAccountSession(
  cookies: ReadonlyRequestCookies,
): Promise<AccountAuthContext> {
  const cookie = cookies.get(ACCOUNT_SESSION_COOKIE);
  if (!cookie?.value) throw errors.accountSessionInvalid('no session cookie');
  const resolved = await resolveAccountSession(cookie.value);
  if (!resolved) throw errors.accountSessionExpired();
  return { userId: resolved.userId, cookieSessionId: cookie.value };
}
