import { NextRequest, NextResponse } from "next/server";
import { redeemMagicLink } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import {
  applySessionCookies,
  clearMagicLinkChallengeCookie,
  magicLinkChallengeFromRequest,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  let response: NextResponse;
  try {
    validatePublicAccessRequest(request);
    const browserChallenge = magicLinkChallengeFromRequest(request);
    if (!browserChallenge) throw exomemErrors.accessTokenInvalid();
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
    const redeemed = await redeemMagicLink({ token: body.token, browserChallenge });
    response = NextResponse.json(
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
      event: "access.magic_link.redeemed",
      outcome: "succeeded",
      requestId,
      tenantId: redeemed.tenantId,
    });
  } catch (error) {
    response = accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
  }
  clearMagicLinkChallengeCookie(response);
  return response;
}
