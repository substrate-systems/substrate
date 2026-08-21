import { NextRequest, NextResponse } from "next/server";
import { getExomemHostedFleetObservation } from "@/lib/exomem-hosted/fleet-observation";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const observation = await getExomemHostedFleetObservation();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, observation, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
