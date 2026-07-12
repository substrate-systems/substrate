import { NextRequest, NextResponse } from "next/server";
import { listOwnerExports, requestOwnerExport } from "@/lib/exomem-hosted/durability";
import { exomemErrors, safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    return NextResponse.json(
      { success: true, exports: await listOwnerExports(session.userId, session.tenantId) },
      { headers: PRIVATE_HEADERS }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value);
    return response;
  }
}

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
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw exomemErrors.idempotencyRequired();
    const result = await requestOwnerExport({
      userId: session.userId,
      tenantId: session.tenantId,
      idempotencyKey,
    });
    return NextResponse.json(
      { success: true, ...result },
      { status: 202, headers: PRIVATE_HEADERS }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(name, value);
    return response;
  }
}
