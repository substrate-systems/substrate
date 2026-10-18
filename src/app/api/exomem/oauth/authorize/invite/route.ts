import { exomemThemeChoice } from "@/lib/exomem/theme";
import { exomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { normalizeTimeZone } from "@/lib/exomem-hosted/time-zone";
import { NextResponse } from "next/server";
import { admitFirstCloudOAuthInviteAtomic } from "@/lib/exomem-hosted/cloud-admission";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";
import { newRequestId } from "@/lib/exomem-hosted/http";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthConsentPath,
  oauthContinuationDigest,
  oauthContinuationToken,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";
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
    // Over the limit, the answer is the retryable one this route gives when Cloud has no room.
    if (
      !(await takeExomemRateLimit(
        EXOMEM_RATE_LIMITS.inviteRedeemIp,
        clientAddressKey(request) ?? "unknown"
      ))
    ) {
      return temporarilyUnavailable(requestId);
    }
    const body = await readBoundedJsonRequest(request, 4096);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["token", "nonce", "timeZone", "emailScheme", "themeChoice"].includes(key)
      ) ||
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
    const admitted = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest,
      transactionDigest,
      sessionDigest: session.sessionDigest,
      csrfDigest: session.csrfDigest,
      sessionExpiresAt: session.expiresAt,
      codeDigest: code.codeDigest,
      codeExpiresAt: code.codeExpiresAt,
      timeZone: normalizeTimeZone((body as Record<string, unknown>).timeZone),
      emailScheme: exomemEmailScheme((body as Record<string, unknown>).emailScheme),
      themeChoice: exomemThemeChoice((body as Record<string, unknown>).themeChoice),
    });
    if (!admitted) return accessDenied();
    // A paid invite is admitted without a code; the consent page continues at checkout.
    const connected = admitted.grantId !== null;
    const response = NextResponse.redirect(
      connected
        ? authorizationRedirect(continuation, code.code)
        : new URL(oauthConsentPath(transaction), exomemPublicBaseUrlFromEnv()),
      303
    );
    for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
      response.headers.set(name, value);
    await applySessionCookies(response, session, request);
    if (connected) clearOAuthContinuationCookie(response);
    return response;
  } catch (error) {
    // HOSTED_ADMISSION_CLOSED is Cloud admission's "no room right now"
    // (cloud-admission.ts): retryable and never the invite's fault, so it gets
    // a 503 rather than an ordinary access denial.
    if (error instanceof ExomemHostedError && error.code === "HOSTED_ADMISSION_CLOSED") {
      return temporarilyUnavailable(requestId);
    }
    return accessDenied();
  }
}
