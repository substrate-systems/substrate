import { NextResponse } from "next/server";
import { attachExistingOwnerAuthorizationAtomic } from "@/lib/exomem-hosted/oauth-store";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthConfirmationHandle,
  oauthContinuationDigest,
  oauthContinuationToken,
  matchesOAuthConfirmationHandle,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { oauthNoStoreHeaders, readOAuthForm } from "@/lib/exomem-hosted/oauth-http";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidRequest(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

// A consent page rendered for an earlier transaction is a dead end today: its
// hidden confirmation and nonce no longer match the live continuation, so the
// only answer is a bare `invalid_request` with nothing the operator can act on.
// That is not an edge case -- a reviewer sign-in redirects the page to a fresh
// render, so ANY second Exomem window left open becomes a stale tab, and one of
// them cost the 2026-08-16 promotion window.
//
// Re-rendering is safe rather than lenient. The caller already presented the
// continuation cookie that the handle is derived from, so this discloses nothing
// they do not hold, and it authorizes nothing: they still have to submit the
// fresh page, with a valid nonce, to mint a code.
function freshConsentPage(transaction: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(
      `/exomem/authorize?confirmation=${encodeURIComponent(oauthConfirmationHandle(transaction))}`,
      exomemPublicBaseUrlFromEnv()
    ),
    303
  );
  for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
    response.headers.set(name, value);
  return response;
}

function accessDenied(): NextResponse {
  return NextResponse.json(
    { error: "access_denied" },
    { status: 403, headers: oauthNoStoreHeaders() }
  );
}

function validOrigin(request: Request): boolean {
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

export async function POST(request: Request): Promise<NextResponse> {
  if (!validOrigin(request)) return invalidRequest();
  let form: Record<string, string>;
  try {
    form = await readOAuthForm(request, ["nonce", "confirmation"]);
  } catch {
    return invalidRequest();
  }
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  const transaction = oauthContinuationToken(request);
  if (!continuation || !transactionDigest || !transaction || !form.nonce) {
    return invalidRequest();
  }
  // Checked before the nonce deliberately: a stale tab carries a stale
  // confirmation AND a stale nonce, so testing the confirmation first is what
  // distinguishes "your page is out of date" from "this nonce is not valid for
  // the live page". The nonce remains a hard failure -- it is this form's CSRF
  // defence, and a mismatch against a current confirmation is not staleness.
  if (!matchesOAuthConfirmationHandle(transaction, form.confirmation)) {
    return freshConsentPage(transaction);
  }
  if (!validateOAuthContinuationNonce({ continuation, transaction, formNonce: form.nonce })) {
    return invalidRequest();
  }
  try {
    const session = await resolveExomemSession(request);
    const code = mintContinuationCode(continuation);
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: session.id,
      transactionDigest,
      codeDigest: code.codeDigest,
      codeExpiresAt: code.codeExpiresAt,
    });
    if (!attached) return accessDenied();
    const response = NextResponse.redirect(authorizationRedirect(continuation, code.code), 303);
    for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
      response.headers.set(name, value);
    clearOAuthContinuationCookie(response);
    return response;
  } catch {
    return accessDenied();
  }
}
