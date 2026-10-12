import { NextRequest, NextResponse } from "next/server";
import { getCloudCapacityStatus } from "@/lib/exomem-hosted/cloud-capacity";
import { executeExomemSql } from "@/lib/exomem-hosted/db";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/exomem/admin/capacity — free Cloud places, from the same count
 * that admission uses. Cloud capacity is observed from the cluster, so there
 * is nothing for an operator to configure here.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const capacity = await getCloudCapacityStatus(executeExomemSql);
    operatorSuccessEvent(requestId);
    return NextResponse.json(
      { success: true, capacity, requestId },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
