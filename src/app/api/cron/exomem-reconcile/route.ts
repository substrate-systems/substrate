import { NextRequest, NextResponse } from "next/server";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";
import { runBoundedLifecycleReconcile } from "@/lib/exomem-hosted/reconcile-runtime";
import { runBoundedPaddleReconcile } from "@/lib/exomem-hosted/paddle-reconciliation-runtime";
import { exomemCloudEnabled } from "@/lib/exomem-hosted/cloud-config";
import { expireCloudAwaitingCheckoutTenants } from "@/lib/exomem-hosted/cloud-admission";
import { runBoundedCloudReconcile } from "@/lib/exomem-hosted/cloud-lifecycle";
import { retryPendingCloudCancellationNotices } from "@/lib/exomem-hosted/cloud-cancellation-notice";

// Task 3.4/3.7's time-driven Cloud sweep, added to the same authenticated
// schedule the hosted lanes already run on (design D1/D4) rather than a new
// scheduled job: the 7-day awaiting-checkout expiry, and the day-30
// cancelled -> deleted transition that no webhook ever fires, and the retry
// of a cancellation notice whose send failed (D4). A true no-op
// with the flag off -- it never runs a query in that case, matching every
// other flag-off Cloud code path in this codebase.
async function runCloudLane(): Promise<{
  expired: number;
  activationsSkipped: number;
  reconciled: number;
  deleted: number;
  noticesRetried: number;
  noticesSent: number;
} | null> {
  if (!exomemCloudEnabled()) return null;
  // Security review finding 8: expiry and the reconcile sweep run
  // independently — a failure in one (each already isolates its own
  // per-tenant failures) must not prevent the other from running this tick.
  const [expiryResult, sweepResult, noticeResult] = await Promise.allSettled([
    expireCloudAwaitingCheckoutTenants(),
    runBoundedCloudReconcile({ maxTenants: 200 }),
    retryPendingCloudCancellationNotices(),
  ]);
  if (expiryResult.status === "rejected") {
    console.error("exomem-cloud: awaiting-checkout expiry lane failed");
  }
  if (sweepResult.status === "rejected") {
    console.error("exomem-cloud: lifecycle reconcile sweep lane failed");
  }
  if (noticeResult.status === "rejected") {
    console.error("exomem-cloud: cancellation notice retry lane failed");
  }
  const expiryOutcomes = expiryResult.status === "fulfilled" ? expiryResult.value : [];
  const sweep = sweepResult.status === "fulfilled" ? sweepResult.value : { reconciled: 0, deleted: 0 };
  const notices =
    noticeResult.status === "fulfilled" ? noticeResult.value : { attempted: 0, sent: 0 };
  return {
    expired: expiryOutcomes.filter((outcome) => outcome.outcome === "expired").length,
    activationsSkipped: expiryOutcomes.filter((outcome) => outcome.outcome === "skipped").length,
    reconciled: sweep.reconciled,
    deleted: sweep.deleted,
    noticesRetried: notices.attempted,
    noticesSent: notices.sent,
  };
}

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
    const [lifecycleResult, paddleResult, cloudResult] = await Promise.allSettled([
      runBoundedLifecycleReconcile({
        maxOperations: 60,
        // Sized to land inside the scheduler contract, not inside the platform
        // ceiling: the caller is a K3s CronJob whose contract pins a 20 s total
        // timeout and a 30 s activeDeadline. A pass that outlived those would
        // still finish its work -- the client disconnecting does not stop the
        // function -- but every draining tick would be recorded as a failed
        // run, and two in a row raise an alert. So the budget stays under the
        // client's timeout, and the gain comes from the waits inside it.
        // 12s, not 15s: the deadline is checked between steps, so a step that
        // starts just inside the budget still runs its provisioner call, which
        // is 5s by default. 12 + 5 leaves margin under the 20s client timeout.
        timeBudgetMs: 12_000,
        // Keep working while the operations this tick started are still
        // producing steps; an empty queue still costs one claim and returns.
        idleWaitMs: 1_500,
      }),
      runBoundedPaddleReconcile({
        maxSubscriptions: 5,
        timeBudgetMs: 8_000,
      }),
      runCloudLane(),
    ]);
    if (
      lifecycleResult.status === "rejected" ||
      paddleResult.status === "rejected" ||
      cloudResult.status === "rejected"
    ) {
      throw new Error("EXOMEM_RECONCILIATION_LANE_FAILED");
    }
    const result = lifecycleResult.value;
    const paddle = paddleResult.value;
    const cloud = cloudResult.value;
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
          // Present only when EXOMEM_CLOUD_ENABLED is on -- absent, not
          // zeroed, when it is off, so an unconfigured deployment's response
          // shape is byte-identical to before this lane existed.
          ...(cloud ? { cloud } : {}),
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
