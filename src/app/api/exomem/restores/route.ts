import { NextRequest, NextResponse } from "next/server";
import { requestOwnerRestore } from "@/lib/exomem-hosted/durability";
import { exomemErrors, safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (typeof body.exportId !== "string" || Object.keys(body).some((key) => key !== "exportId")) {
      throw exomemErrors.invalidRequest();
    }
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) throw exomemErrors.idempotencyRequired();
    const result = await requestOwnerRestore({
      userId: session.userId,
      tenantId: session.tenantId,
      exportId: body.exportId,
      idempotencyKey,
    });
    return NextResponse.json(
      { success: true, ...result },
      {
        status: 202,
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "x-robots-tag": "noindex, nofollow",
        },
      }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
