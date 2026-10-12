import { NextRequest, NextResponse } from "next/server";
import { loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import { cloudExportsEnabled, readCloudExport } from "@/lib/exomem-hosted/cloud-exports";
import { getOwnerCloudHomeStatus } from "@/lib/exomem-hosted/cloud-status";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const { status, storage } = await getOwnerCloudHomeStatus(session.tenantId);
    // The export row rides the poll once the export release flag is on.
    const exportSummary = cloudExportsEnabled() ? await readCloudExport(session) : undefined;
    const connectorUrl = cloudConnectorUrl();
    return NextResponse.json(
      {
        success: true,
        status,
        storage,
        ...(exportSummary ? { export: exportSummary } : {}),
        ...(connectorUrl ? { cloudConnectorUrl: connectorUrl } : {}),
      },
      { headers }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
