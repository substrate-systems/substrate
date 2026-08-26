import { NextRequest, NextResponse } from "next/server";
import { drainDeletionCompletionDeliveries } from "@/lib/exomem-hosted/deletion-completion-delivery";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";
import { runBoundedLifecycleReconcile } from "@/lib/exomem-hosted/reconcile-runtime";
import { runBoundedPaddleReconcile } from "@/lib/exomem-hosted/paddle-reconciliation-runtime";

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
    const [lifecycleResult, paddleResult] = await Promise.allSettled([
      runBoundedLifecycleReconcile({
        maxOperations: 10,
        timeBudgetMs: 8_000,
      }),
      runBoundedPaddleReconcile({
        maxSubscriptions: 5,
        timeBudgetMs: 8_000,
      }),
    ]);
    const [completionResult] = await Promise.allSettled([
      drainDeletionCompletionDeliveries({ maxMessages: 5, timeBudgetMs: 8_000 }),
    ]);
    if (
      lifecycleResult.status === "rejected" ||
      paddleResult.status === "rejected" ||
      completionResult.status === "rejected"
    ) {
      throw new Error("EXOMEM_RECONCILIATION_LANE_FAILED");
    }
    const result = lifecycleResult.value;
    const paddle = paddleResult.value;
    const deletionCompletion = completionResult.value;
    return NextResponse.json(
      {
        success: true,
        result: {
          attempted: result.attempted,
          advanced: result.advanced,
          succeeded: result.succeeded,
          retryScheduled: result.retryScheduled,
          terminal: result.terminal,
          paddle: {
            configured: paddle.configured,
            attempted: paddle.attempted,
            applied: paddle.applied,
            duplicate: paddle.duplicate,
            stale: paddle.stale,
            ignored: paddle.ignored,
            failed: paddle.failed,
          },
          deletionCompletion: {
            claimed: deletionCompletion.claimed,
            sent: deletionCompletion.sent,
            retryScheduled: deletionCompletion.retryScheduled,
            failed: deletionCompletion.failed,
            lost: deletionCompletion.lost,
          },
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
