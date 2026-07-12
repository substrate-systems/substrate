import { NextRequest, NextResponse } from "next/server";
import { redeemInvite } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { applySessionCookies } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (typeof body.token !== "string" || body.token.length === 0 || Object.hasOwn(body, "email")) {
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
