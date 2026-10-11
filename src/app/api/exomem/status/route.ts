import { NextRequest, NextResponse } from "next/server";
import { loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import { getOwnerCloudStatus, type LifecycleStatus } from "@/lib/exomem-hosted/cloud-status";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The codes mapCloudCellToLifecycleStatus returns, plus the fallback below.
const SAFE_STATUS_CODES = new Set([
  "TENANT_PREPARING",
  "PAYMENT_REQUIRED",
  "CELL_PREPARING",
  "CELL_READY",
  "CELL_NOT_READY",
  "CELL_UNAVAILABLE",
  "EXOMEM_SUSPENDED",
  "EXOMEM_DELETED",
]);

function safeStatus(status: LifecycleStatus): LifecycleStatus {
  return {
    ...status,
    code: SAFE_STATUS_CODES.has(status.code) ? status.code : "CELL_UNAVAILABLE",
  };
}

// Item 6 / task 3.7: never lets a misconfigured Cloud deployment fail the
// whole status check -- the caller still gets a status, just without a
// connector URL to show.
function cloudConnectorUrl(): string | undefined {
  try {
    return loadExomemCloudResource().mcpUrl;
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    const headers = {
      "cache-control": "private, no-store, max-age=0",
      "x-robots-tag": "noindex, nofollow",
    };
    const status = safeStatus(await getOwnerCloudStatus(session.tenantId));
    const connectorUrl = cloudConnectorUrl();
    return NextResponse.json(
      { success: true, status, ...(connectorUrl ? { cloudConnectorUrl: connectorUrl } : {}) },
      { headers }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
