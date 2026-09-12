import { randomUUID } from "node:crypto";
import { expireCanaryAuthority } from "./agent-contract-canaries";
import { terminateExomemBillingForDeletion } from "./billing-deletion";
import { SqlLifecycleStore } from "./lifecycle-store";
import { HttpCellProvisioner, provisionerConfigFromEnv } from "./provisioner";
import {
  LifecycleReconciler,
  expectedCellConfigurationFromEnv,
  type LifecycleStatus,
} from "./reconciler";

function runtime() {
  const store = new SqlLifecycleStore();
  const provisioner = new HttpCellProvisioner(provisionerConfigFromEnv());
  const reconciler = new LifecycleReconciler({
    store,
    provisioner,
    config: expectedCellConfigurationFromEnv(),
    terminateBilling: terminateExomemBillingForDeletion,
  });
  return { store, reconciler };
}

export type ReconcileSummary = {
  attempted: number;
  advanced: number;
  succeeded: number;
  retryScheduled: number;
  terminal: number;
  /**
   * Authorization renewals raised this tick, and the two ways a due cell can
   * fail to get one.
   *
   * `renewalsBlocked` counts cells held off by an unrelated sibling operation
   * and `renewalsFailed` counts enqueues that threw -- typically a cell whose
   * contract target cannot be resolved, since the schema refuses a v2 operation
   * without one. Both are silent otherwise, and a cell that misses its window
   * cannot be recovered, so they are carried out to the cron response rather
   * than discarded here.
   */
  renewalsEnqueued: number;
  renewalsBlocked: number;
  renewalsFailed: number;
};

export async function runBoundedLifecycleReconcile(
  input: {
    maxOperations?: number;
    timeBudgetMs?: number;
    tenantId?: string;
    /**
     * How long to wait for the next step of work this tick has already started,
     * before concluding the queue is empty. Zero, the default, preserves the
     * original stop-on-first-idle behaviour for every other caller.
     *
     * A step that finishes typically schedules its successor a second or two
     * out. Without this the tick returns immediately and that successor waits
     * for the next cron minute, so an operation advances one checkpoint per
     * tick: measured 2026-09-12, a cell delete took 23 minutes of which under a
     * second was work, and a provision the same. Waiting here is what lets one
     * tick carry an operation through several checkpoints.
     */
    idleWaitMs?: number;
  } = {}
): Promise<ReconcileSummary> {
  const maxOperations = Math.min(200, Math.max(1, input.maxOperations ?? 10));
  const timeBudgetMs = Math.min(55_000, Math.max(250, input.timeBudgetMs ?? 8_000));
  const idleWaitMs = Math.min(5_000, Math.max(0, input.idleWaitMs ?? 0));
  // Bounds the polling an in-flight operation can cause. Past this many waits
  // with nothing to claim, the work this tick started is finished or parked
  // further out than a tick can usefully wait.
  const maxIdleWaits = 10;
  const startedAt = Date.now();
  const { store, reconciler } = runtime();
  const owner = `substrate-${randomUUID()}`;
  const summary: ReconcileSummary = {
    attempted: 0,
    advanced: 0,
    succeeded: 0,
    retryScheduled: 0,
    terminal: 0,
    renewalsEnqueued: 0,
    renewalsBlocked: 0,
    renewalsFailed: 0,
  };
  await expireCanaryAuthority(Math.min(maxOperations, 20));
  // Enqueue before draining the queue, so a renewal raised this tick is driven
  // this tick. The attestation window is one hour and a cell that outlives it
  // cannot be recovered, so latency here is not merely untidy.
  //
  // The per-tick share bounds the fleet this sweep can keep alive: a 20-minute
  // margin at a one-minute cadence is 20 ticks x 5 cells = 100, assuming each
  // renewal completes in the tick that raised it. Far above alpha scale, but it
  // is a ceiling on an unrecoverable failure, so it is written down here rather
  // than rediscovered by whoever grows the fleet past it.
  const renewals = await store.enqueueDueAuthorizationRenewals(Math.min(maxOperations, 5));
  summary.renewalsEnqueued = renewals.enqueued;
  summary.renewalsBlocked = renewals.blocked;
  summary.renewalsFailed = renewals.failed;
  let idleWaits = 0;
  let attemptsLeft = maxOperations;
  while (attemptsLeft > 0) {
    if (Date.now() - startedAt >= timeBudgetMs) break;
    const result = await reconciler.reconcileOne({
      owner,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    });
    if (result.kind === "idle") {
      // Only wait for work that is actually producing steps. An empty queue
      // must cost exactly one claim, as it did before: the endpoint is billed
      // for being awake, so an idle tick that polls is the expensive mistake
      // this change would otherwise introduce.
      //
      // Progress, not attempts: a `retry_scheduled` operation backs off
      // exponentially to a minute, far past anything worth waiting for, and a
      // `terminal` one is finished. Keying on attempts would let a single
      // backed-off operation hold every tick open for its full wait budget,
      // indefinitely.
      if (idleWaitMs === 0 || summary.advanced + summary.succeeded === 0) break;
      if (idleWaits >= maxIdleWaits) break;
      if (timeBudgetMs - (Date.now() - startedAt) <= idleWaitMs) break;
      idleWaits += 1;
      await new Promise((resolve) => setTimeout(resolve, idleWaitMs));
      continue;
    }
    idleWaits = 0;
    attemptsLeft -= 1;
    summary.attempted += 1;
    if (result.kind === "advanced") summary.advanced += 1;
    if (result.kind === "succeeded") summary.succeeded += 1;
    if (result.kind === "retry_scheduled") summary.retryScheduled += 1;
    if (result.kind === "terminal") summary.terminal += 1;
  }
  return summary;
}

export async function immediateBestEffortReconcile(
  tenantId: string
): Promise<{ attempted: boolean; code: string }> {
  try {
    const result = await runBoundedLifecycleReconcile({
      tenantId,
      maxOperations: 1,
      timeBudgetMs: 2_000,
    });
    return {
      attempted: result.attempted > 0,
      code: result.attempted > 0 ? "RECONCILE_STEP_ACCEPTED" : "RECONCILE_IDLE",
    };
  } catch {
    // A status poll must remain available during provisioner/configuration
    // outages. Never log the caught object: it may retain a provider cause.
    return { attempted: false, code: "RECONCILE_UNAVAILABLE" };
  }
}

export async function getOwnerLifecycleStatus(tenantId: string): Promise<LifecycleStatus> {
  return new SqlLifecycleStore().statusForTenant(tenantId);
}
