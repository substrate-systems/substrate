import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import { runBoundedLifecycleReconcile } from "@/lib/exomem-hosted/reconcile-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronAuth(request).ok) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
  try {
    const result = await runBoundedLifecycleReconcile({
      maxOperations: 10,
      timeBudgetMs: 8_000,
    });
    return NextResponse.json(
      {
        success: true,
        result: {
          attempted: result.attempted,
          advanced: result.advanced,
          succeeded: result.succeeded,
          retryScheduled: result.retryScheduled,
          terminal: result.terminal,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    // The underlying failure may carry a private provider cause. The cron
    // boundary deliberately emits only a stable code and no caught object.
    return NextResponse.json(
      {
        success: false,
        error: { code: "CONTROL_PLANE_UNAVAILABLE", retryable: true },
      },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
