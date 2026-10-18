import { NextRequest, NextResponse } from "next/server";
import { readAccessRecoveryReceipt, uniformAccessStartResponse } from "@/lib/exomem-hosted/access-recovery";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  accessErrorResponse,
  emitAccessEvent,
  newRequestId,
  readBoundedJsonRequest,
} from "@/lib/exomem-hosted/http";
import { validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resend reads the address only from the opaque receipt; its uniform answer cannot authenticate or enumerate an account. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    const body = await readBoundedJsonRequest(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
      throw exomemErrors.invalidRequest();
    const prior = readAccessRecoveryReceipt(request);
    const response = await uniformAccessStartResponse(request, {
      email: prior?.email ?? "",
      timeZone: prior?.timeZone ?? null,
      emailScheme: prior?.emailScheme ?? null,
      themeChoice: prior?.themeChoice ?? null,
      requestId,
      resend: true,
    });
    emitAccessEvent({ event: "access.start.accepted", outcome: "succeeded", requestId });
    return response;
  } catch (error) {
    const response = accessErrorResponse({ error, event: "access.request.denied", requestId });
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
