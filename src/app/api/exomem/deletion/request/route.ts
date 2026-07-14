import { NextRequest, NextResponse } from "next/server";
import { requestDeletionConfirmation } from "@/lib/exomem-hosted/deletion";
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
    await requestDeletionConfirmation(session);
    return NextResponse.json(
      { success: true, state: "confirmation_sent" },
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
