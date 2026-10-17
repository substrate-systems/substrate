import { NextRequest, NextResponse } from "next/server";
import { exomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { redeemMagicLink } from "@/lib/exomem-hosted/access";
import { readAccessRecoveryReceipt, recoveryLinkState } from "@/lib/exomem-hosted/access-recovery";
import { ExomemHostedError, exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  accessErrorResponse,
  emitAccessEvent,
  newRequestId,
  readBoundedJsonRequest,
} from "@/lib/exomem-hosted/http";
import {
  clearOAuthContinuationCookie,
  liveOAuthConsentPath,
} from "@/lib/exomem-hosted/oauth-continuity";
import {
  applySessionCookies,
  clearMagicLinkChallengeCookie,
  magicLinkChallengeFromRequest,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";
import { normalizeTimeZone } from "@/lib/exomem-hosted/time-zone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  let response: NextResponse;
  let failedToken: string | null = null;
  try {
    validatePublicAccessRequest(request);
    const input = await readBoundedJsonRequest(request, 2048);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw exomemErrors.invalidRequest();
    const body = input as Record<string, unknown>;
    if (
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      (body.expectedEmail !== undefined && typeof body.expectedEmail !== "string") ||
      Object.keys(body).some(
        (key) =>
          key !== "token" && key !== "timeZone" && key !== "emailScheme" && key !== "expectedEmail"
      )
    ) {
      throw exomemErrors.invalidRequest();
    }
    failedToken = body.token;
    const browserChallenge = magicLinkChallengeFromRequest(request);
    const redeemed = await redeemMagicLink({
      token: body.token,
      browserChallenge,
      expectedEmail: body.expectedEmail as string | undefined,
      timeZone: normalizeTimeZone(body.timeZone),
      emailScheme: exomemEmailScheme(body.emailScheme),
    });
    response = NextResponse.json(
      {
        success: true,
        status: "accepted",
        destination: redeemed.browserChallengeMatched
          ? ((await liveOAuthConsentPath(request)) ?? "/exomem/home")
          : "/exomem/home",
        requestId,
      },
      { status: 200 }
    );
    applySessionCookies(response, redeemed);
    if (!redeemed.browserChallengeMatched) clearOAuthContinuationCookie(response);
    emitAccessEvent({
      event: "access.magic_link.redeemed",
      outcome: "succeeded",
      requestId,
      tenantId: redeemed.tenantId,
    });
  } catch (error) {
    let failure = error;
    if (
      failedToken &&
      error instanceof ExomemHostedError &&
      (error.code === "ACCESS_TOKEN_INVALID" || error.code === "EMAIL_CONFIRMATION_REQUIRED")
    ) {
      const receipt = readAccessRecoveryReceipt(request);
      const state = receipt
        ? await recoveryLinkState(receipt, failedToken).catch(() => null)
        : null;
      if (state)
        failure = new ExomemHostedError({
          code: state === "expired" ? "ACCESS_LINK_EXPIRED" : "ACCESS_LINK_USED",
          status: 401,
          message:
            state === "expired"
              ? "This sign-in link has expired."
              : "This sign-in link was already used.",
          retryable: true,
        });
    }
    response = accessErrorResponse({
      error: failure,
      event: "access.request.denied",
      requestId,
    });
  }
  clearMagicLinkChallengeCookie(response);
  response.headers.set("cache-control", "no-store");
  return response;
}
