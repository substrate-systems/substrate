import { NextRequest, NextResponse } from "next/server";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";
import { runExportGc } from "@/lib/exomem-hosted/export-gc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyHostedSchedulerAuth(request).ok) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
  try {
    const result = await runExportGc({ maxExports: 10, timeBudgetMs: 8_000 });
    return NextResponse.json(
      {
        success: true,
        result: {
          attempted: result.attempted,
          deleted: result.deleted,
          retryScheduled: result.retryScheduled,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "EXPORT_GC_UNAVAILABLE", retryable: true },
      },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
