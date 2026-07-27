import { NextRequest, NextResponse } from "next/server";
import { safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { getOwnerLifecycleStatus } from "@/lib/exomem-hosted/reconcile-runtime";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";
import type { LifecycleStatus } from "@/lib/exomem-hosted/reconciler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_STATUS_CODES = new Set([
  "TENANT_PREPARING",
  "CELL_PREPARING",
  "CELL_READY",
  "CELL_NOT_READY",
  "CELL_UNAVAILABLE",
  "CELL_READINESS_MISMATCH",
  "CELL_BINDING_CONFLICT",
  "LIFECYCLE_MAX_ATTEMPTS",
  "CAPACITY_UNAVAILABLE",
  "PROVISIONER_UNAVAILABLE",
  "PROVISIONER_TIMEOUT",
  "PROVISIONER_CONFIGURATION_INVALID",
  "PROVISIONER_REJECTED",
  "PROVISIONER_RESPONSE_INVALID",
  "BILLING_TERMINATION_UNAVAILABLE",
  "EXOMEM_SUSPENDED",
  "DELETION_IN_PROGRESS",
  "EXOMEM_DELETED",
]);

function safeStatus(status: LifecycleStatus): LifecycleStatus {
  return {
    ...status,
    code: SAFE_STATUS_CODES.has(status.code) ? status.code : "CELL_UNAVAILABLE",
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    const status = safeStatus(await getOwnerLifecycleStatus(session.tenantId));
    return NextResponse.json(
      { success: true, status },
      {
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "x-robots-tag": "noindex, nofollow",
        },
      }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
