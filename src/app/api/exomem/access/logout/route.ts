import { NextRequest, NextResponse } from "next/server";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import {
  clearSessionCookies,
  resolveExomemSession,
  revokeResolvedSession,
  validateMutationRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    await revokeResolvedSession(session);
    const response = NextResponse.json(
      { success: true, status: "signed_out", requestId },
      { status: 200 }
    );
    clearSessionCookies(response);
    emitAccessEvent({
      event: "access.logout.succeeded",
      outcome: "succeeded",
      requestId,
      tenantId: session.tenantId,
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
