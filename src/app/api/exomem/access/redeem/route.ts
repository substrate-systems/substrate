import { exomemThemeChoice } from "@/lib/exomem/theme";
import { NextRequest, NextResponse } from "next/server";
import { exomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { admitFirstCloudOAuthInviteAtomic, redeemCloudInvite } from "@/lib/exomem-hosted/cloud-admission";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthConsentPath,
  oauthContinuationDigest,
  oauthContinuationToken,
  oauthFormNonceFromRequest,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
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
import { normalizeTimeZone } from "@/lib/exomem-hosted/time-zone";

/** The journey's "Add Exomem to your assistant" step, where a paid start continues. */
const PAID_WEB_DESTINATION = "/exomem/setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    if (
      !(await takeExomemRateLimit(
        EXOMEM_RATE_LIMITS.inviteRedeemIp,
        clientAddressKey(request) ?? "unknown"
      ))
    ) {
      throw exomemErrors.rateLimited();
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      Object.keys(body).some(
        (key) => key !== "token" && key !== "timeZone" && key !== "emailScheme" && key !== "themeChoice"
      )
    ) {
      throw exomemErrors.invalidRequest();
    }
    const timeZone = normalizeTimeZone(body.timeZone);
    const emailScheme = exomemEmailScheme(body.emailScheme);
    const themeChoice = exomemThemeChoice(body.themeChoice);
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
      const admitted = await admitFirstCloudOAuthInviteAtomic({
        inviteDigest,
        transactionDigest,
        sessionDigest: session.sessionDigest,
        csrfDigest: session.csrfDigest,
        sessionExpiresAt: session.expiresAt,
        codeDigest: code.codeDigest,
        codeExpiresAt: code.codeExpiresAt,
        timeZone,
        emailScheme,
        themeChoice,
      });
      if (!admitted) throw exomemErrors.accessTokenInvalid();
      // A paid invite is admitted without a code. The continuation stays open, and
      // the consent page continues at checkout with the new session.
      const connected = admitted.grantId !== null;
      const response = NextResponse.json(
        {
          success: true,
          status: "accepted",
          destination: connected
            ? authorizationRedirect(continuation, code.code)
            : oauthConsentPath(transaction),
          requestId,
        },
        { status: 200, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
      );
      await applySessionCookies(response, session, request);
      if (connected) clearOAuthContinuationCookie(response);
      return response;
    }
    const redeemed = await redeemCloudInvite(body.token, { timeZone, emailScheme, themeChoice });
    const response = NextResponse.json(
      {
        success: true,
        status: "accepted",
        destination: redeemed.paid ? PAID_WEB_DESTINATION : "/exomem/home",
        requestId,
      },
      { status: 200 }
    );
    await applySessionCookies(response, redeemed, request);
    emitAccessEvent({
      event: "access.invite.redeemed",
      outcome: "succeeded",
      requestId,
      tenantId: redeemed.tenantId,
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
