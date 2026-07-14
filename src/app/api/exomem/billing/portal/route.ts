import { NextRequest, NextResponse } from "next/server";
import { startOwnerPortal } from "@/lib/exomem-hosted/billing-account";
import { exomemErrors, safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
      throw exomemErrors.invalidRequest();
    }
    const result = await startOwnerPortal(session.userId, session.tenantId);
    return NextResponse.json(
      { success: true, ...result },
      { headers: { "cache-control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    return response;
  }
}
