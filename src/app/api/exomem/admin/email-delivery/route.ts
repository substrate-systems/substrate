import { NextRequest, NextResponse } from "next/server";
import {
  readEmailDeliveryReport,
  parseEmailDeliveryHours,
} from "@/lib/exomem-hosted/email-delivery-report";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/exomem/admin/email-delivery?hours=N — what became of each kind of
 * Exomem email over the last N hours (default 24, at most 168): queued, sent,
 * failed, cancelled, pending, how long each step took, and what the provider
 * reported. Delivery fields are `null`, never 0, until the provider's webhook
 * has delivered an event.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const hours = parseEmailDeliveryHours(request.nextUrl.searchParams.get("hours"));
    if (hours === null) throw exomemErrors.invalidRequest();
    const report = await readEmailDeliveryReport(hours);
    operatorSuccessEvent(requestId);
    return NextResponse.json(
      { success: true, report, requestId },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
