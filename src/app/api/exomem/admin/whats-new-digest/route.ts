import { NextRequest, NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";
import {
  applyDigestAction,
  describeMonth,
  describeOverview,
  parseMonthName,
} from "@/lib/exomem-hosted/whats-new-digest/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The months and the measurement, or with `?month=YYYY-MM` that month's detail. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const requested = request.nextUrl.searchParams.get("month");
    let body: object;
    if (requested === null) {
      body = { overview: await describeOverview() };
    } else {
      const month = parseMonthName(requested);
      if (!month) throw exomemErrors.invalidRequest();
      body = { month: await describeMonth(month) };
    }
    operatorSuccessEvent(requestId);
    return NextResponse.json(
      { success: true, ...body, requestId },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

/** `action`: `blind_pick`, `accept_missing`, `approve`, `edit`, `skip`, `stop` (each with `month`) and `set_switch`. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const result = await applyDigestAction(await readOperatorJsonRecord(request));
    operatorSuccessEvent(requestId);
    const body = "months" in result ? { overview: result } : { month: result };
    return NextResponse.json(
      { success: true, ...body, requestId },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
