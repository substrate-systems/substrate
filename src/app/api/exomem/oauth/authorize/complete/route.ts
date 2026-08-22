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

type CompleteRejectionStage = "origin" | "form" | "continuation" | "nonce";

// Every gate below answers an identical bare `invalid_request`, which is right
// for the caller and useless for the operator: on 2026-08-22 a live promotion
// window produced a 400 here that could not be attributed to any of the four
// causes from outside, because the response, the status and the access log are
// the same for all of them. This names the gate without telling the caller
// anything: it goes to the server log only, and it records presence and shape
// rather than values -- no token, nonce, confirmation handle or cookie is
// logged, matching `logAuthorizeRejection` on the sibling authorize route.
function logCompleteRejection(
  stage: CompleteRejectionStage,
  diagnostics?: Record<string, boolean | number | string>
): void {
  console.error({
    event: "exomem_oauth_authorize_complete_rejection",
    stage,
    ...(diagnostics ?? {}),
  });
}

function invalidRequest(
  stage: CompleteRejectionStage,
  diagnostics?: Record<string, boolean | number | string>
): NextResponse {
  logCompleteRejection(stage, diagnostics);
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
  if (!validOrigin(request)) {
    return invalidRequest("origin", {
      origin_present: request.headers.get("origin") !== null,
      host_present: request.headers.get("host") !== null,
      sec_fetch_site: request.headers.get("sec-fetch-site") ?? "absent",
    });
  }
  let form: Record<string, string>;
  try {
    form = await readOAuthForm(request, ["nonce", "confirmation"]);
  } catch {
    return invalidRequest("form", {
      content_type: request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "absent",
      content_length: request.headers.get("content-length") ?? "absent",
    });
  }
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  const transaction = oauthContinuationToken(request);
  if (!continuation || !transactionDigest || !transaction || !form.nonce) {
    // Distinguishes "the browser sent no continuation cookie" from "it sent one
    // the store would not resolve" -- a live transaction that has expired, been
    // consumed, or lost its bootstrap authority. Those need opposite responses
    // and were indistinguishable.
    return invalidRequest("continuation", {
      transaction_cookie_present: transaction !== null,
      transaction_digest_present: transactionDigest !== null,
      continuation_resolved: continuation !== null,
      form_nonce_present: !!form.nonce,
    });
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
    return invalidRequest("nonce");
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
