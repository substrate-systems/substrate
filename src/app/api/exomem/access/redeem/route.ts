import { NextRequest, NextResponse } from "next/server";
import { redeemInvite } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthContinuationDigest,
  oauthContinuationToken,
  oauthFormNonceFromRequest,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { admitFirstOAuthInviteAtomic } from "@/lib/exomem-hosted/oauth-store";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import {
  applySessionCookies,
  mintSessionMaterial,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      Object.keys(body).length !== 1
    ) {
      throw exomemErrors.invalidRequest();
    }
    const transaction = oauthContinuationToken(request);
    const formNonce = oauthFormNonceFromRequest(request);
    if (transaction || formNonce) {
      const transactionDigest = oauthContinuationDigest(request);
      if (!transaction || !transactionDigest || !formNonce) {
        throw exomemErrors.invalidRequest();
      }
      const continuation = await resolveOAuthContinuation(request);
      if (
        !continuation ||
        !validateOAuthContinuationNonce({ continuation, transaction, formNonce })
      ) {
        throw exomemErrors.invalidRequest();
      }
      const inviteDigest = tokenDigest(body.token);
      if (!inviteDigest) throw exomemErrors.accessTokenInvalid();
      const session = mintSessionMaterial();
      const code = mintContinuationCode(continuation);
      const admitted = await admitFirstOAuthInviteAtomic({
        inviteDigest,
        transactionDigest,
        sessionDigest: session.sessionDigest,
        csrfDigest: session.csrfDigest,
        sessionExpiresAt: session.expiresAt,
        codeDigest: code.codeDigest,
        codeExpiresAt: code.codeExpiresAt,
      });
      if (!admitted) throw exomemErrors.accessTokenInvalid();
      const response = NextResponse.json(
        {
          success: true,
          status: "accepted",
          destination: authorizationRedirect(continuation, code.code),
          requestId,
        },
        { status: 200, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
      );
      applySessionCookies(response, session);
      clearOAuthContinuationCookie(response);
      return response;
    }
    const redeemed = await redeemInvite(body.token);
    const response = NextResponse.json(
      {
        success: true,
        status: "accepted",
        destination: "/exomem/home",
        requestId,
      },
      { status: 200 }
    );
    applySessionCookies(response, redeemed);
    emitAccessEvent({
      event: "access.invite.redeemed",
      outcome: "succeeded",
      requestId,
      tenantId: redeemed.tenantId,
      operationId: redeemed.operationId,
    });
    return response;
  } catch (error) {
    return accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
  }
}
