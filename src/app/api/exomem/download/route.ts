import { NextRequest, NextResponse } from "next/server";
import { safeErrorResponse, exomemErrors } from "@/lib/exomem-hosted/errors";
import { hasForbiddenGatewayHeaders } from "@/lib/exomem-hosted/gateway";
import { newRequestId, readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { createDirectTransferTicket } from "@/lib/exomem-hosted/transfers";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_TICKET_REQUEST_BYTES = 8 * 1024;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    if (request.nextUrl.search || hasForbiddenGatewayHeaders(request.headers)) {
      throw exomemErrors.selectorRejected();
    }
    if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw exomemErrors.invalidRequest();
    }
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const body = await readBoundedJsonRequest(request, MAX_TICKET_REQUEST_BYTES);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).join(",") !== "path" ||
      typeof (body as Record<string, unknown>).path !== "string"
    ) {
      throw exomemErrors.invalidRequest();
    }
    const ticket = await createDirectTransferTicket({
      session,
      request: { operation: "download", path: (body as { path: string }).path },
    });
    return NextResponse.json(
      { success: true, data: ticket },
      {
        headers: {
          "cache-control": "no-store, private",
          "x-exomem-request-id": requestId,
        },
      }
    );
  } catch (error) {
    const response = safeErrorResponse(error, requestId);
    response.headers.set("cache-control", "no-store, private");
    response.headers.set("x-exomem-request-id", requestId);
    return response;
  }
}
