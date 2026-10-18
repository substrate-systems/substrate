import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadExomemEmailChange, requestExomemEmailChange } from "@/lib/exomem-hosted/email-change";
import { loadPaddleReceiptContact } from "@/lib/exomem-hosted/paddle-receipt-contact";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const RequestChange = z.object({ email: z.string().max(254) }).strict();
const headers = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    return NextResponse.json(
      {
        success: true,
        pending: await loadExomemEmailChange(session),
        receipts: await loadPaddleReceiptContact(session),
      },
      { headers }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const input = RequestChange.safeParse(await readBoundedJsonRequest(request, 512));
    if (!input.success) throw exomemErrors.invalidRequest();
    return NextResponse.json(
      { success: true, ...(await requestExomemEmailChange(session, input.data.email)) },
      { status: 202, headers }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}
