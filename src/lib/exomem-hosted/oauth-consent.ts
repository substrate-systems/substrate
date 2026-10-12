/**
 * The consent page's answers to an OAuth authorization request: Connect
 * (`/authorize/complete`) and "Not now" / "Keep it as it is"
 * (`/authorize/decline`). Both routes use the same origin rule, and a decline
 * ends the request without a code.
 */

import { executeExomemSql } from "./db";

// Chrome sends `Origin: null` for a form POST issued by a document whose
// referrer policy is `no-referrer` -- which the consent page sets deliberately,
// via `referrer: "no-referrer"` in its own metadata. The Fetch standard ties the
// two together: under that policy the request's origin is serialized as the
// string "null". So the page's privacy hardening made every Connect submission
// unattributable, and this gate rejected all of them. It could not succeed in
// Chrome, and never had: every test here builds the request by hand with a clean
// Origin, so nothing exercised what a browser actually sends. It cost the
// 2026-08-16 and 2026-08-22 promotion windows.
//
// `Sec-Fetch-Site` is the trustworthy signal. It is a forbidden header name, so
// no page, script or extension can set or forge it -- only the browser writes
// it. `same-origin` is the browser asserting the request came from this very
// origin, which is precisely what this check exists to establish, and it is
// strictly stronger than comparing an Origin string the same browser may have
// redacted. When the browser sends Sec-Fetch metadata we believe it and ignore
// Origin; when it does not, fall back to the Origin/host comparison for clients
// that predate Fetch Metadata.
//
// This is not a relaxation. A cross-site POST still reports `cross-site` and is
// still refused, and the form nonce -- bound to an httpOnly cookie the attacker
// cannot read -- remains the actual CSRF defence, unchanged.
export function validOrigin(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Ends a live authorization request without a code. Exactly one caller can
 * consume a transaction: this UPDATE, Connect and the invitation redeem all
 * require `consumed_at IS NULL` under the row lock, so a double submit, or a
 * decline racing a Connect, consumes it once.
 *
 * `redirectUri` is the one `resolveOAuthContinuation` re-validated against the
 * client. Binding it here means the caller can only ever send the visitor back
 * to the redirect stored on the row it consumed. No grant or code is written.
 */
export async function consumeDeclinedOAuthAuthorization(input: {
  transactionDigest: Buffer;
  redirectUri: string;
  sessionId: string | null;
}): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:decline-oauth-authorization */
    UPDATE exomem_oauth_authorization_transactions
    SET consumed_at = now(),
        -- Records the signed-in session that declined. A session that ended
        -- since it was read records no one rather than failing on the foreign
        -- key, and a session a reviewer sign-in already bound is kept.
        redeemed_session_id = COALESCE(
          (SELECT session.id FROM exomem_sessions AS session
           WHERE session.id = ${input.sessionId}::uuid),
          redeemed_session_id
        )
    WHERE transaction_digest = ${input.transactionDigest}
      AND consumed_at IS NULL
      AND expires_at > now()
      AND redirect_uri = ${input.redirectUri}
    RETURNING id
  `;
  return rows.length === 1;
}
