import { NextResponse } from "next/server";
import { attachExistingOwnerAuthorizationAtomic } from "@/lib/exomem-hosted/oauth-store";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthConsentPath,
  oauthContinuationDigest,
  oauthContinuationToken,
  matchesOAuthConfirmationHandle,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { isSafeLoopbackOAuthRedirect } from "@/lib/exomem-hosted/oauth-client-admission";
import { validOrigin } from "@/lib/exomem-hosted/oauth-consent";
import { oauthNoStoreHeaders, readOAuthForm } from "@/lib/exomem-hosted/oauth-http";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CompleteRejectionStage = "origin" | "form" | "continuation" | "nonce";

// The origin, form and nonce gates below answer an identical bare `invalid_request`,
// and the continuation gate sends the visitor to the expired-request page. That is
// right for the caller and useless for the operator: on 2026-08-22 a live promotion
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
//
// A refused Connect comes back here too. The account changed between render and
// submit (signed out, payment still due, paused, ended), and the fresh page shows
// the step that state needs, where a 403 body showed raw JSON.
function freshConsentPage(transaction: string): NextResponse {
  return consentPageRedirect(oauthConsentPath(transaction));
}

// With no live continuation there is no handle to return to. The bare page shows
// the expired request and asks the visitor to start again from their app.
function expiredConsentPage(): NextResponse {
  return consentPageRedirect("/exomem/authorize");
}

function consentPageRedirect(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, exomemPublicBaseUrlFromEnv()), 303);
  for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
    response.headers.set(name, value);
  return response;
}

// Bounded deliberately: a rejected body is by definition not one this server
// vouched for, so its field names are untrusted input on their way to a log.
// Cap the count and the length rather than trusting `readOAuthForm`'s limits,
// which may be the very checks that just threw.
async function submittedFieldNames(request: Request): Promise<string> {
  try {
    const params = new URLSearchParams(await request.text());
    const names: string[] = [];
    for (const [key] of params) {
      names.push(key.slice(0, 32));
      if (names.length === 8) break;
    }
    return names.join(",") || "none";
  } catch {
    return "unreadable";
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (isJsonRequest(request)) return completeForPage(request);
  if (!validOrigin(request)) {
    // Origin and host are public hostnames that already appear on every access
    // log line, so recording them costs no confidentiality and is the only way
    // to tell "this browser sent no Origin" from "it sent one that disagreed
    // with the host we were reached on".
    return invalidRequest("origin", {
      origin: request.headers.get("origin") ?? "absent",
      host: request.headers.get("host") ?? "absent",
      sec_fetch_site: request.headers.get("sec-fetch-site") ?? "absent",
    });
  }
  // Cloned before the body is consumed, and read only when parsing has already
  // failed. `readOAuthForm` rejects an unrecognized field, a duplicate key and a
  // malformed body with the same error, so without the field NAMES a rejection
  // here says only "the form was wrong" -- and an extra field injected by a
  // password manager or extension looks exactly like a malformed body.
  const formShape = request.clone();
  let form: Record<string, string>;
  try {
    form = await readOAuthForm(request, ["nonce", "confirmation"]);
  } catch (caught) {
    return invalidRequest("form", {
      error_code: caught instanceof ExomemHostedError ? caught.code : "unknown",
      content_type: request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "absent",
      content_length: request.headers.get("content-length") ?? "absent",
      // Names only. The values are the nonce and the confirmation handle.
      field_names: await submittedFieldNames(formShape),
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
    logCompleteRejection("continuation", {
      transaction_cookie_present: transaction !== null,
      transaction_digest_present: transactionDigest !== null,
      continuation_resolved: continuation !== null,
      form_nonce_present: !!form.nonce,
    });
    return expiredConsentPage();
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
    if (!attached) return freshConsentPage(transaction);
    const response = NextResponse.redirect(authorizationRedirect(continuation, code.code), 303);
    for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
      response.headers.set(name, value);
    clearOAuthContinuationCookie(response);
    return response;
  } catch {
    return freshConsentPage(transaction);
  }
}

const MAX_COMPLETE_JSON_BYTES = 4 * 1024;

function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

// Exactly these two fields, as the form path reads them.
function completeBody(value: unknown): { confirmation: string; nonce: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2) return null;
  const { confirmation, nonce } = body;
  if (typeof confirmation !== "string" || !confirmation) return null;
  if (typeof nonce !== "string" || !nonce) return null;
  return { confirmation, nonce };
}

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: oauthNoStoreHeaders() });
}

// Connect from the consent page's script. It runs the form path's gates in the
// same order and the same store call, and answers in the decline route's shape,
// so the page can show the hand-back before the browser leaves, and tell an app
// on this computer in the background. The form path above stays for a browser
// without JavaScript.
async function completeForPage(request: Request): Promise<NextResponse> {
  if (!validOrigin(request)) {
    logCompleteRejection("origin", {
      sec_fetch_site: request.headers.get("sec-fetch-site") ?? "absent",
    });
    return json({ error: "invalid_request" }, 400);
  }
  let body: { confirmation: string; nonce: string } | null;
  try {
    body = completeBody(await readBoundedJsonRequest(request, MAX_COMPLETE_JSON_BYTES));
  } catch {
    body = null;
  }
  if (!body) {
    logCompleteRejection("form", { content_type: "application/json" });
    return json({ error: "invalid_request" }, 400);
  }
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  const transaction = oauthContinuationToken(request);
  if (!continuation || !transactionDigest || !transaction) {
    logCompleteRejection("continuation", {
      transaction_cookie_present: transaction !== null,
      transaction_digest_present: transactionDigest !== null,
      continuation_resolved: continuation !== null,
    });
    return json({ status: "expired" }, 410);
  }
  // A stale tab, a signed-out browser and an account that changed since the page
  // rendered all get the same answer the form path gives them: the fresh page.
  const fresh = () => json({ status: "stale", consentPath: oauthConsentPath(transaction) }, 409);
  if (!matchesOAuthConfirmationHandle(transaction, body.confirmation)) return fresh();
  if (!validateOAuthContinuationNonce({ continuation, transaction, formNonce: body.nonce })) {
    logCompleteRejection("nonce");
    return json({ error: "invalid_request" }, 400);
  }
  let sessionId: string;
  try {
    sessionId = (await resolveExomemSession(request)).id;
  } catch (error) {
    if (error instanceof ExomemHostedError) return fresh();
    return failed();
  }
  const code = mintContinuationCode(continuation);
  let attached: Awaited<ReturnType<typeof attachExistingOwnerAuthorizationAtomic>>;
  try {
    attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId,
      transactionDigest,
      codeDigest: code.codeDigest,
      codeExpiresAt: code.codeExpiresAt,
    });
  } catch {
    return failed();
  }
  if (!attached) return fresh();
  const response = json(
    {
      status: "connected",
      redirectUrl: authorizationRedirect(continuation, code.code).toString(),
      loopback: isSafeLoopbackOAuthRedirect(continuation.redirectUri),
    },
    200
  );
  clearOAuthContinuationCookie(response);
  return response;
}

// Storage failed, or its answer was lost. A lost COMMIT acknowledgement throws after
// PostgreSQL has committed, so the app may be connected: the page says that it
// could not confirm the connection, never that nothing changed.
function failed(): NextResponse {
  console.error({ event: "exomem_oauth_authorize_complete_failed" });
  return json({ error: "server_error" }, 500);
}
