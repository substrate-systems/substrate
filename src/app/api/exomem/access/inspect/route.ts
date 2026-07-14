import { NextRequest, NextResponse } from "next/server";
import { inspectInvite } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, newRequestId } from "@/lib/exomem-hosted/http";
import { validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      Object.keys(body).some((key) => key !== "token")
    ) {
      throw exomemErrors.invalidRequest();
    }
    const result = await inspectInvite(body.token);
    return NextResponse.json(
      { success: true, ...result, requestId },
      {
        status: 200,
        headers: { "cache-control": "no-store, private" },
      }
    );
  } catch (error) {
    const response = accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
    response.headers.set("cache-control", "no-store, private");
    return response;
  }
}
