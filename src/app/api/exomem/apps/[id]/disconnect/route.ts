import { NextResponse } from "next/server";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/exomem-hosted/http";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { disconnectOwnerApp } from "@/lib/exomem-hosted/owner-apps";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const { id } = await context.params;
    // Another account's app and an id that never existed answer the same 404.
    const disconnected = await disconnectOwnerApp({
      userId: session.userId,
      tenantId: session.tenantId,
      appId: id,
    });
    return NextResponse.json(disconnected ? { status: "disconnected" } : { status: "not_found" }, {
      status: disconnected ? 200 : 404,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS))
      response.headers.set(name, value);
    return response;
  }
}
