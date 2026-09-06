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
  } = {}
): Promise<ReconcileSummary> {
  const maxOperations = Math.min(20, Math.max(1, input.maxOperations ?? 10));
  const timeBudgetMs = Math.min(20_000, Math.max(250, input.timeBudgetMs ?? 8_000));
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
  for (let index = 0; index < maxOperations; index += 1) {
    if (Date.now() - startedAt >= timeBudgetMs) break;
    const result = await reconciler.reconcileOne({
      owner,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    });
    if (result.kind === "idle") break;
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
