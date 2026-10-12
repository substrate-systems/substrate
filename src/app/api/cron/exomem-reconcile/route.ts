import { NextRequest, NextResponse } from "next/server";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";
import { runBoundedPaddleReconcile } from "@/lib/exomem-hosted/paddle-reconciliation-runtime";
import { expireCloudAwaitingCheckoutTenants } from "@/lib/exomem-hosted/cloud-admission";
import { runBoundedCloudReconcile } from "@/lib/exomem-hosted/cloud-lifecycle";
import { retryPendingCloudCancellationNotices } from "@/lib/exomem-hosted/cloud-cancellation-notice";
import { runBoundedCloudDeletionFinish } from "@/lib/exomem-hosted/cloud-deletion-finish";
import {
  promoteWaitlistedPeople,
  pruneStaleWaitlistEntries,
  type WaitlistPromotionResult,
} from "@/lib/exomem-hosted/self-serve-admission";

// Task 3.4/3.7's time-driven Cloud sweep (design D1/D4): the 7-day
// awaiting-checkout expiry, the day-30 cancelled -> deleted transition that no
// webhook ever fires, the retry of a cancellation notice whose send failed
// (D4), the waitlist promotion into slots those steps freed and the waitlist
// retention, and the Cloud deletion finish of every confirmed account
// deletion (D4).
async function runCloudLane(): Promise<{
  expired: number;
  activationsSkipped: number;
  reconciled: number;
  deleted: number;
  noticesRetried: number;
  noticesSent: number;
  deletionsFinished: number;
  deletionsPending: number;
  deletionsFailed: number;
  waitlistPromotion: WaitlistPromotionResult | { status: "failed"; promoted: null; settled: null };
  waitlistPruned: number | null;
}> {
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
  // Waitlist promotion runs after expiry and the sweep, so a slot they freed
  // goes to the oldest waiting person in the same tick. It is isolated: its
  // failure is reported as failed, never as zero promotions.
  let waitlistPromotion:
    | WaitlistPromotionResult
    | { status: "failed"; promoted: null; settled: null };
  try {
    waitlistPromotion = await promoteWaitlistedPeople({ maxPromotions: 20 });
  } catch {
    console.error("exomem-cloud: waitlist promotion lane failed");
    waitlistPromotion = { status: "failed", promoted: null, settled: null };
  }
  // Retention runs whatever the admission setting (see
  // pruneStaleWaitlistEntries). `null` reports a failed run, never zero.
  let waitlistPruned: number | null;
  try {
    waitlistPruned = await pruneStaleWaitlistEntries();
  } catch {
    console.error("exomem-cloud: waitlist retention lane failed");
    waitlistPruned = null;
  }
  // D4 "Cloud deletion finish": after the sweep has deleted the cell rows of
  // confirmed deletions, cancel their billing and scrub them. Each tenant is
  // isolated inside the finish; a failure of the lane itself counts nothing.
  let deletions = { finished: 0, pending: 0, failed: 0 };
  try {
    deletions = await runBoundedCloudDeletionFinish({ maxTenants: 25, timeBudgetMs: 8_000 });
  } catch {
    console.error("exomem-cloud: account deletion finish lane failed");
  }
  const expiryOutcomes = expiryResult.status === "fulfilled" ? expiryResult.value : [];
  const sweep =
    sweepResult.status === "fulfilled" ? sweepResult.value : { reconciled: 0, deleted: 0 };
  const notices =
    noticeResult.status === "fulfilled" ? noticeResult.value : { attempted: 0, sent: 0 };
  return {
    expired: expiryOutcomes.filter((outcome) => outcome.outcome === "expired").length,
    activationsSkipped: expiryOutcomes.filter((outcome) => outcome.outcome === "skipped").length,
    reconciled: sweep.reconciled,
    deleted: sweep.deleted,
    noticesRetried: notices.attempted,
    noticesSent: notices.sent,
    deletionsFinished: deletions.finished,
    deletionsPending: deletions.pending,
    deletionsFailed: deletions.failed,
    waitlistPromotion,
    waitlistPruned,
  };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyHostedSchedulerAuth(request).ok) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
  try {
    const [paddleResult, cloudResult] = await Promise.allSettled([
      runBoundedPaddleReconcile({
        maxSubscriptions: 5,
        timeBudgetMs: 8_000,
      }),
      runCloudLane(),
    ]);
    if (paddleResult.status === "rejected" || cloudResult.status === "rejected") {
      throw new Error("EXOMEM_RECONCILIATION_LANE_FAILED");
    }
    const paddle = paddleResult.value;
    return NextResponse.json(
      {
        success: true,
        result: {
          paddle: {
            configured: paddle.configured,
            attempted: paddle.attempted,
            applied: paddle.applied,
            duplicate: paddle.duplicate,
            stale: paddle.stale,
            ignored: paddle.ignored,
            failed: paddle.failed,
          },
          cloud: cloudResult.value,
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
