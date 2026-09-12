import { NextRequest, NextResponse } from "next/server";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";
import { runBoundedLifecycleReconcile } from "@/lib/exomem-hosted/reconcile-runtime";
import { runBoundedPaddleReconcile } from "@/lib/exomem-hosted/paddle-reconciliation-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The tick is the only thing that moves a lifecycle operation, so its ceiling
// is the cell's latency floor. At the previous 8-second budget an operation
// advanced one checkpoint per cron interval whatever the interval was.
export const maxDuration = 60;

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
        maxOperations: 60,
        // Sized to land inside the scheduler contract, not inside the platform
        // ceiling: the caller is a K3s CronJob whose contract pins a 20 s total
        // timeout and a 30 s activeDeadline. A pass that outlived those would
        // still finish its work -- the client disconnecting does not stop the
        // function -- but every draining tick would be recorded as a failed
        // run, and two in a row raise an alert. So the budget stays under the
        // client's timeout, and the gain comes from the waits inside it.
        timeBudgetMs: 15_000,
        // Keep working while the operations this tick started are still
        // producing steps; an empty queue still costs one claim and returns.
        idleWaitMs: 1_500,
      }),
      runBoundedPaddleReconcile({
        maxSubscriptions: 5,
        timeBudgetMs: 8_000,
      }),
    ]);
    if (lifecycleResult.status === "rejected" || paddleResult.status === "rejected") {
      throw new Error("EXOMEM_RECONCILIATION_LANE_FAILED");
    }
    const result = lifecycleResult.value;
    const paddle = paddleResult.value;
    return NextResponse.json(
      {
        success: true,
        result: {
          attempted: result.attempted,
          advanced: result.advanced,
          succeeded: result.succeeded,
          retryScheduled: result.retryScheduled,
          terminal: result.terminal,
          renewalsEnqueued: result.renewalsEnqueued,
          renewalsBlocked: result.renewalsBlocked,
          renewalsFailed: result.renewalsFailed,
          paddle: {
            configured: paddle.configured,
            attempted: paddle.attempted,
            applied: paddle.applied,
            duplicate: paddle.duplicate,
            stale: paddle.stale,
            ignored: paddle.ignored,
            failed: paddle.failed,
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
