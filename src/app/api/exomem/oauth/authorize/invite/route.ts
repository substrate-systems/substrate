import { NextResponse } from "next/server";
import { admitFirstCloudOAuthInviteAtomic } from "@/lib/exomem-hosted/cloud-admission";
import { exomemCloudEnabled } from "@/lib/exomem-hosted/cloud-config";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";
import { newRequestId } from "@/lib/exomem-hosted/http";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { admitFirstOAuthInviteAtomic } from "@/lib/exomem-hosted/oauth-store";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthContinuationDigest,
  oauthContinuationToken,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import {
  applySessionCookies,
  mintSessionMaterial,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidRequest(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

function accessDenied(): NextResponse {
  return NextResponse.json(
    { error: "access_denied" },
    { status: 403, headers: oauthNoStoreHeaders() }
  );
}

function temporarilyUnavailable(requestId: string): NextResponse {
  return NextResponse.json(
    { error: "temporarily_unavailable", request_id: requestId },
    { status: 503, headers: { ...oauthNoStoreHeaders(), "retry-after": "1" } }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  const transaction = oauthContinuationToken(request);
  if (!continuation || !transactionDigest || !transaction) return invalidRequest();
  try {
    validatePublicAccessRequest(request);
    const body = await readBoundedJsonRequest(request, 4096);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      typeof (body as { token?: unknown }).token !== "string" ||
      typeof (body as { nonce?: unknown }).nonce !== "string"
    ) {
      return invalidRequest();
    }
    if (
      !validateOAuthContinuationNonce({
        continuation,
        transaction,
        formNonce: (body as { nonce: string }).nonce,
      })
    ) {
      return invalidRequest();
    }
    const inviteDigest = tokenDigest((body as { token: string }).token);
    if (!inviteDigest) return accessDenied();
    const session = mintSessionMaterial();
    const code = mintContinuationCode(continuation);
    const admitted = exomemCloudEnabled()
      ? await admitFirstCloudOAuthInviteAtomic({
          inviteDigest,
          transactionDigest,
          sessionDigest: session.sessionDigest,
          csrfDigest: session.csrfDigest,
          sessionExpiresAt: session.expiresAt,
          codeDigest: code.codeDigest,
          codeExpiresAt: code.codeExpiresAt,
        })
      : await admitFirstOAuthInviteAtomic({
          inviteDigest,
          transactionDigest,
          sessionDigest: session.sessionDigest,
          csrfDigest: session.csrfDigest,
          sessionExpiresAt: session.expiresAt,
          codeDigest: code.codeDigest,
          codeExpiresAt: code.codeExpiresAt,
        });
    if (!admitted) return accessDenied();
    const response = NextResponse.redirect(authorizationRedirect(continuation, code.code), 303);
    for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
      response.headers.set(name, value);
    applySessionCookies(response, session);
    clearOAuthContinuationCookie(response);
    return response;
  } catch (error) {
    // Security review finding 11: CAPACITY_UNAVAILABLE is the hosted
    // capacity-pool exhaustion code; HOSTED_ADMISSION_CLOSED is Cloud's
    // (cloud-admission.ts). Both are a retryable "no room right now", never
    // the invite's fault, so both get the same 503 rather than being folded
    // into an ordinary access denial — but the mapping is gated on the same
    // flag that chose which admission function actually ran above. Neither
    // function can throw the other's code in ordinary operation, so this
    // changes no normal response; it means a routing bug that let the wrong
    // admission path run would surface as an unexpected access_denied
    // rather than being silently absorbed as a plausible-looking 503.
    const expectedCode = exomemCloudEnabled() ? "HOSTED_ADMISSION_CLOSED" : "CAPACITY_UNAVAILABLE";
    if (error instanceof ExomemHostedError && error.code === expectedCode) {
      return temporarilyUnavailable(requestId);
    }
    return accessDenied();
  }
}
