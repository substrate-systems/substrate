/**
 * GUI → web Account Portal handoff. See [[Endstate Account Portal Architecture]]
 * (decision, 2026-05-26) and hosted-backup-contract.md §4–§5.
 *
 * The handoff is two-token:
 *
 *  1. A 60s EdDSA JWT (`aud: endstate-account`, minted via
 *     `mintBrowserSessionToken`) is returned by the engine to the GUI.
 *     The GUI opens `<accountUrl>?session=<jwt>` in the system browser.
 *  2. The `/account` page exchanges the JWT for an HttpOnly cookie session
 *     (1h Max-Age, opaque id, DB-backed). The JWT's `jti` is burned at
 *     redeem; replays return `BROWSER_SESSION_CONSUMED`.
 *
 * The JWT is a bootstrap-only credential — the page itself, and any POSTs
 * back from it, authenticate via the cookie. The JWT never sees a second
 * request.
 */

import { randomBytes } from 'node:crypto';
import {
  mintBrowserSessionToken as mintBrowserSessionJwt,
  verifyBrowserSessionToken,
} from './jwt';
import {
  burnBrowserSessionJti,
  deleteAccountSession,
  findAccountSession,
  insertAccountSession,
} from './db';
import { errors } from './errors';

const COOKIE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_ID_BYTES = 32;

function getIssuer(): string {
  return process.env.ENDSTATE_OIDC_ISSUER_URL ?? 'https://substratesystems.io';
}

function getAccountPortalUrl(): string {
  // Engine reads `endstate_extensions.account_portal_url` from OIDC
  // discovery; this is the value substrate advertises. Self-hosters who
  // relocate the portal must override via env. The token-redeem step is
  // a GET to `/account/start?session=<jwt>` — that route swaps the JWT
  // for a cookie and 302s into the cookie-only `/account` page.
  return (
    process.env.ENDSTATE_ACCOUNT_PORTAL_URL ?? `${getIssuer()}/account/start`
  );
}

export type MintedBrowserSession = {
  sessionToken: string;
  accountUrl: string;
};

/** Mint a 60s handoff token for `userId`. Engine-side endpoint calls this. */
export async function mintBrowserSession(
  userId: string,
): Promise<MintedBrowserSession> {
  const { token } = await mintBrowserSessionJwt({ userId });
  return { sessionToken: token, accountUrl: getAccountPortalUrl() };
}

export type RedeemedBrowserSession = {
  userId: string;
  cookieSessionId: string;
  cookieExpiresAt: Date;
};

/**
 * Validate a handoff token and mint the cookie-session it bootstraps.
 * Throws `errors.invalidToken` / `errors.tokenExpired` /
 * `errors.browserSessionConsumed` on failure. On success, the JWT's `jti`
 * is burned (single-use); a fresh opaque session id is stored in
 * `account_sessions` with a 1-hour TTL.
 */
export async function redeemBrowserSession(
  token: string,
): Promise<RedeemedBrowserSession> {
  const { userId, jti } = await verifyBrowserSessionToken(token);
  const firstUse = await burnBrowserSessionJti(jti);
  if (!firstUse) throw errors.browserSessionConsumed();

  const cookieSessionId = randomBytes(SESSION_ID_BYTES).toString('base64url');
  const cookieExpiresAt = new Date(Date.now() + COOKIE_TTL_MS);
  await insertAccountSession({
    sessionId: cookieSessionId,
    userId,
    expiresAt: cookieExpiresAt,
  });
  return { userId, cookieSessionId, cookieExpiresAt };
}

export async function resolveAccountSession(
  sessionId: string,
): Promise<{ userId: string } | null> {
  const row = await findAccountSession(sessionId);
  if (!row) return null;
  return { userId: row.userId };
}

export async function invalidateAccountSession(
  sessionId: string,
): Promise<void> {
  await deleteAccountSession(sessionId);
}

export const ACCOUNT_SESSION_COOKIE = 'endstate_account_session';
export const ACCOUNT_SESSION_MAX_AGE_S = Math.floor(COOKIE_TTL_MS / 1000);
