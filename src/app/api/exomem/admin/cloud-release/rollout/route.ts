import { NextRequest, NextResponse } from "next/server";
import { getCloudRolloutView } from "@/lib/exomem-hosted/cloud-release";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// automate-cloud-releases D1: the bounded rollout view, the one read the
// deploy token has. It names no cell and no tenant, and its size does not
// grow with the fleet.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read", "deploy");
    const view = await getCloudRolloutView();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, view, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
