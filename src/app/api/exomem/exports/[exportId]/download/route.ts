import { NextRequest, NextResponse } from "next/server";
import { ownerExportDownload } from "@/lib/exomem-hosted/durability";
import { safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ exportId: string }> }
): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    const { exportId } = await context.params;
    const result = await ownerExportDownload({
      userId: session.userId,
      tenantId: session.tenantId,
      exportId,
    });
    const response = NextResponse.redirect(result.url, 303);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
