import { NextRequest, NextResponse } from "next/server";
import { resumeReturnedOwnerCheckout } from "@/lib/exomem-hosted/billing-account";
import { exomemErrors, safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PADDLE_TRANSACTION_ID = /^txn_[a-z0-9]{26}$/;

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
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw exomemErrors.invalidRequest();
    }
    const keys = Object.keys(body);
    const transactionId = (body as Record<string, unknown>).transactionId;
    if (
      keys.length > 1 ||
      (keys.length === 1 &&
        (keys[0] !== "transactionId" ||
          typeof transactionId !== "string" ||
          !PADDLE_TRANSACTION_ID.test(transactionId)))
    ) {
      throw exomemErrors.invalidRequest();
    }
    let result: Record<string, unknown>;
    if (typeof transactionId === "string") {
      const returned = await resumeReturnedOwnerCheckout(
        session.userId,
        session.tenantId,
        transactionId
      );
      result =
        returned.state === "settled" ? { ...returned, redirectUrl: "/exomem/home" } : returned;
    } else {
      throw exomemErrors.entitlementDenied();
    }
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
