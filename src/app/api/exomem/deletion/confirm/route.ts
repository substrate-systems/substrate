import { NextRequest, NextResponse } from "next/server";
import { confirmDeletion } from "@/lib/exomem-hosted/deletion";
import { exomemErrors, safeErrorResponse } from "@/lib/exomem-hosted/errors";
import {
  clearSessionCookies,
  resolveExomemSession,
  validateMutationRequest,
} from "@/lib/exomem-hosted/sessions";

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
    if (typeof body.token !== "string" || Object.keys(body).some((key) => key !== "token")) {
      throw exomemErrors.invalidRequest();
    }
    const result = await confirmDeletion(body.token, session);
    const response = NextResponse.json(
      { success: true, ...result },
      {
        status: 202,
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "x-robots-tag": "noindex, nofollow",
        },
      }
    );
    clearSessionCookies(response);
    return response;
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
