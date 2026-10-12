import { NextResponse } from "next/server";
import { isLoopbackRedirectDestination } from "@/lib/exomem-hosted/oauth-client-admission";
import { consumeDeclinedOAuthAuthorization, validOrigin } from "@/lib/exomem-hosted/oauth-consent";
import {
  authorizationDenialRedirect,
  clearOAuthContinuationCookie,
  matchesOAuthConfirmationHandle,
  oauthConsentPath,
  oauthContinuationDigest,
  oauthContinuationToken,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { emitAccessEvent, readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DECLINE_BODY_BYTES = 4 * 1024;

// "Not now" and "Keep it as it is". Both end the request the same way; the
// outcome only names which button the owner pressed.
const DECLINE_OUTCOMES = ["declined", "kept"] as const;
type DeclineOutcome = (typeof DECLINE_OUTCOMES)[number];

type DeclineBody = { confirmation: string; nonce: string; outcome: DeclineOutcome };

// Exactly these three fields, so no field a caller adds can reach the redirect.
// Only a caller that sends extra fields is refused, and the consent page never does.
function declineBody(value: unknown): DeclineBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 3) return null;
  const { confirmation, nonce, outcome } = body;
  if (typeof confirmation !== "string" || !confirmation) return null;
  if (typeof nonce !== "string" || !nonce) return null;
  if (!DECLINE_OUTCOMES.includes(outcome as DeclineOutcome)) return null;
  return { confirmation, nonce, outcome: outcome as DeclineOutcome };
}

function json(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: oauthNoStoreHeaders() });
}

// Names the failing gate in the server log without any value from the request,
// as the sibling complete route does: every 400 here looks the same to the caller.
function invalidRequest(stage: "origin" | "body" | "nonce"): NextResponse {
  console.error({ event: "exomem_oauth_authorize_decline_rejection", stage });
  return json({ error: "invalid_request" }, 400);
}

// Records who declined when the browser is signed in. The decline itself needs
// no session: the continuation cookie and the form nonce are its authority.
async function signedInSessionId(request: Request): Promise<string | null> {
  try {
    return (await resolveExomemSession(request)).id;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    return await decline(request);
  } catch {
    // Storage failed. The transaction may or may not be consumed; a retry
    // answers 410 if it was, so the page can say so instead of guessing here.
    console.error({ event: "exomem_oauth_authorize_decline_failed" });
    return json({ error: "server_error" }, 500);
  }
}

async function decline(request: Request): Promise<NextResponse> {
  if (!validOrigin(request)) return invalidRequest("origin");
  let body: DeclineBody | null;
  try {
    body = declineBody(await readBoundedJsonRequest(request, MAX_DECLINE_BODY_BYTES));
  } catch {
    body = null;
  }
  if (!body) return invalidRequest("body");

  const continuation = await resolveOAuthContinuation(request);
  const transaction = oauthContinuationToken(request);
  const transactionDigest = oauthContinuationDigest(request);
  if (!continuation || !transaction || !transactionDigest) {
    return json({ status: "expired" }, 410);
  }
  // Confirmation before nonce, as in complete: a stale tab carries both a stale
  // confirmation and a stale nonce, and only the confirmation tells them apart.
  if (!matchesOAuthConfirmationHandle(transaction, body.confirmation)) {
    return json({ status: "stale", consentPath: oauthConsentPath(transaction) }, 409);
  }
  if (!validateOAuthContinuationNonce({ continuation, transaction, formNonce: body.nonce })) {
    return invalidRequest("nonce");
  }

  const consumed = await consumeDeclinedOAuthAuthorization({
    transactionDigest,
    redirectUri: continuation.redirectUri,
    sessionId: await signedInSessionId(request),
  });
  if (!consumed) return json({ status: "expired" }, 410);

  emitAccessEvent({
    event: body.outcome === "kept" ? "oauth.authorize.kept" : "oauth.authorize.declined",
    outcome: "succeeded",
  });
  const response = json(
    {
      status: body.outcome,
      redirectUrl: authorizationDenialRedirect(continuation),
      loopback: isLoopbackRedirectDestination(continuation.redirectUri),
    },
    200
  );
  clearOAuthContinuationCookie(response);
  return response;
}
