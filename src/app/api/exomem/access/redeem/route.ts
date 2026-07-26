import { NextRequest, NextResponse } from "next/server";
import { redeemInvite } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { oauthContinuationDigest } from "@/lib/exomem-hosted/oauth-continuity";
import { applySessionCookies, validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    // OAuth admission has its own all-or-nothing transaction. Never let the
    // pre-MCP redemption path consume an invite while a continuation is live.
    if (oauthContinuationDigest(request)) throw exomemErrors.invalidRequest();
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
