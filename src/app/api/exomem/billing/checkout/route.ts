import { NextRequest, NextResponse } from "next/server";
import {
  resumeReturnedOwnerCheckout,
  startOwnerCheckout,
} from "@/lib/exomem-hosted/billing-account";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { liveOAuthConsentPath } from "@/lib/exomem-hosted/oauth-continuity";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PADDLE_TRANSACTION_ID = /^txn_[a-z0-9]{26}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    if (session.reviewerCredentialKind === "cloud_provider_review")
      throw exomemErrors.entitlementDenied();
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
      // A checkout started from the consent page returns there while its OAuth
      // transaction is live, so the visitor connects next; otherwise Home.
      result =
        returned.state === "settled"
          ? { ...returned, redirectUrl: (await liveOAuthConsentPath(request)) ?? "/exomem/home" }
          : returned;
    } else {
      result = await startOwnerCheckout(session.userId, session.tenantId);
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
