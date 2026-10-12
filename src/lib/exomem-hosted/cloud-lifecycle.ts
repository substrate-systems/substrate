/**
 * Exomem Cloud lifecycle: entitlement to desired state (design D4,
 * `adopt-exomem-cloud-plain-cells`).
 *
 * Additive and gated: nothing here is called from any hosted code path.
 * Every transition is a plain `UPDATE ... SET desired_state = ...` on
 * `exomem_cloud_cells` — the C1 trigger (migration 0056) does the rest:
 * bumping `generation` and notifying the controller. This module never calls
 * a provisioner, claims a lifecycle lease or holds a fence, matching D4's
 * "the control plane MUST NOT" clause.
 *
 * The read/write decision for each entitlement state is computed by the
 * existing, provider-neutral `evaluateExomemEntitlement` (entitlements.ts) —
 * not re-derived here — so Cloud and hosted never drift on what "grace"
 * or "provider-paused" or "manually suspended" actually allow.
 */

import { revokeCloudResourceConsent } from "./cloud-consent";
import { executeExomemSql, withExomemTransaction } from "./db";
import {
  evaluateExomemEntitlement,
  EXOMEM_ALPHA_BUNDLE,
  type EffectiveExomemEntitlement,
  type EvaluateExomemEntitlementInput,
} from "./entitlements";
import {
  CLOUD_AWAITING_CHECKOUT_EXPIRY_DAYS,
  CLOUD_SWEEP_PADDLE_BUDGET_MS,
  DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS,
} from "./cloud-config";
import {
  cancelExomemCheckoutTransaction,
  ExomemBillingError,
  paddleTransportUntil,
  type PaddleTransport,
} from "./paddle-billing";
import { loadExomemPaddleTransactionConfig, type ExomemPaddleConfig } from "./paddle-config";
import { recoverPaidResubscription } from "./resubscribe-recovery";

export type CloudDesiredCellState = "running" | "read_only" | "stopped" | "deleted";

/**
 * D4's mapping, keyed off the same read/write decisions
 * `evaluateExomemEntitlement` already computes:
 *
 * - allow/allow (active, trialing, complimentary active)              -> running
 * - allow/deny  (grace, provider-paused, cancelled within its window) -> read_only
 * - deny/deny   (manually suspended, complimentary revoked)           -> stopped
 * - deleted                                                            -> deleted
 *
 * `cancelled`'s time-bound conversion to `deleted` is not decidable from
 * the entitlement alone — it needs how long it has been cancelled — so
 * that step lives in `desiredCloudCellState`, one level up.
 */
export function mapEntitlementToCloudDesiredState(
  entitlement: EffectiveExomemEntitlement
): CloudDesiredCellState {
  if (entitlement.effectiveState === "deleted") return "deleted";
  if (entitlement.decisions.read.allowed && entitlement.decisions.write.allowed) return "running";
  if (entitlement.decisions.read.allowed) return "read_only";
  return "stopped";
}

export type CloudEntitlementSnapshot = {
  tenantId: string;
  manuallySuspended: boolean;
  sourceProjection: EvaluateExomemEntitlementInput["sourceProjection"];
  /** When the entitlement last authoritatively changed (e.g. the provider webhook's occurred_at). */
  sourceOccurredAt: Date | null;
};

/**
 * The last instant a cancelled tenant's memory is kept (read-only) before its
 * cell becomes `deleted`. `sourceOccurredAt` moves with every later applied
 * provider event, so the date can move too.
 */
export function cloudCancelledKeptUntil(
  sourceOccurredAt: Date,
  retentionDays: number = DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS
): Date {
  return new Date(sourceOccurredAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * D4's full mapping, including the cancelled-tenant export window: `read_only`
 * while within `cancelledRetentionDays` of the entitlement's last transition,
 * `deleted` once that window has elapsed. Resubscribing within the window
 * needs no special handling here — the entitlement source state simply
 * becomes `active` again, and the ordinary allow/allow branch returns
 * `running`, exactly matching "resubscribing within the window returns the
 * row to running."
 */
export function desiredCloudCellState(
  snapshot: CloudEntitlementSnapshot,
  options: { cancelledRetentionDays?: number; now?: Date } = {}
): CloudDesiredCellState {
  const entitlement = evaluateExomemEntitlement({
    lifecycleState: "ready", // Cloud tenants past admission are always past "provisioning" in the hosted sense.
    sourceProjection: snapshot.sourceProjection,
    manuallySuspended: snapshot.manuallySuspended,
    bundle: EXOMEM_ALPHA_BUNDLE,
  });
  const base = mapEntitlementToCloudDesiredState(entitlement);
  if (entitlement.effectiveState !== "cancelled") return base;

  if (!snapshot.sourceOccurredAt) return "read_only";
  const now = options.now ?? new Date();
  const keptUntil = cloudCancelledKeptUntil(
    snapshot.sourceOccurredAt,
    options.cancelledRetentionDays
  );
  return now.getTime() >= keptUntil.getTime() ? "deleted" : "read_only";
}

type EntitlementRow = {
  tenant_id: string;
  source: "complimentary" | "paddle";
  source_state: string;
  manual_suspended_at: Date | null;
  source_occurred_at: Date | null;
  provider_transaction_ref: string | null;
};

/**
 * Paddle's five post-payment subscription states, the only ones
 * `evaluateExomemEntitlement` knows how to project into a read/write
 * decision. `awaiting_checkout` and `checkout_pending` (cloud-admission.ts's
 * pre-payment source_state) are deliberately NOT in this list: every one of
 * the five recognised states allows at least a read, so a pre-payment or
 * otherwise-unrecognised state must never be coerced into one of them —
 * that was the bug (security review finding 1, BLOCKER): an unrecognised
 * state fell back to "cancelled", which allows read_only. `toSourceProjection`
 * returns `null` instead, and its caller maps that directly to `stopped`,
 * bypassing entitlement evaluation entirely rather than guessing a state.
 */
const RECOGNIZED_PADDLE_STATES = ["active", "trialing", "past_due", "paused", "cancelled"] as const;
type RecognizedPaddleState = (typeof RECOGNIZED_PADDLE_STATES)[number];

function toSourceProjection(
  row: EntitlementRow
): EvaluateExomemEntitlementInput["sourceProjection"] | null {
  if (row.source === "complimentary") {
    // The only value ever written for a complimentary row is
    // 'complimentary_active' (db.ts, oauth-store.ts) — there is no
    // 'complimentary_revoked' source_state. "Revoking" a complimentary
    // grant is done by setting manual_suspended_at, which dataPolicy checks
    // before it ever looks at source/state, so this "active" is correct
    // even for a since-suspended tenant.
    return { source: "complimentary", state: "active" };
  }
  if (!(RECOGNIZED_PADDLE_STATES as readonly string[]).includes(row.source_state)) {
    return null;
  }
  return { source: "paddle", state: row.source_state as RecognizedPaddleState };
}

export type LapsedCheckoutSettlement = {
  /** The bound transaction cannot pay for the cell any more; its binding is cleared. */
  settled: number;
  /** The bound transaction paid for a live subscription; the owner is resumed. */
  resumed: number;
  /** Paddle gave no proof either way, or the budget ran out first; the cell stays read-only. */
  waiting: number;
};

export type LapsedCheckoutOptions = {
  cancelledRetentionDays?: number;
  /** Paddle time for the whole batch. Tenants it does not reach wait for the next tick. */
  budgetMs?: number;
  maxTenants?: number;
  now?: Date;
  cancelTransaction?: typeof cancelExomemCheckoutTransaction;
  recoverResubscription?: typeof recoverPaidResubscription;
  config?: ExomemPaddleConfig;
  transport?: PaddleTransport;
};

// A tick reaches at most this many lapsed tenants; the rest wait for the next.
const LAPSED_CHECKOUT_MAX_TENANTS = 25;

type LapsedCheckout = {
  tenant_id: string;
  owner_user_id: string;
  source_revision: string | null;
  provider_transaction_ref: string;
  provider_environment: "sandbox" | "production" | null;
  provider_customer_ref: string | null;
};

/**
 * Before a lapsed export window deletes a cancelled tenant's cell, the
 * Paddle transaction still bound to it is settled, the way
 * `expireCloudAwaitingCheckoutTenants` settles an unpaid hold. Only proof
 * clears the binding and lets the cell go: Paddle cancelled the transaction
 * (an open resubscription checkout is cancelled here), it reports the
 * transaction under another owner, or the subscription it paid for has
 * ended. A transaction that paid for a live subscription resumes the owner
 * (`recoverPaidResubscription`), in case its subscription event never came.
 *
 * Any other answer, including a payment Paddle has not finished, keeps the
 * cell read-only. If Paddle stays down, every lapsed cell with a bound
 * transaction outlives its window and keeps its Cloud slot until Paddle
 * answers; each tick asks again within its budget.
 */
export async function settleLapsedCheckouts(
  options: LapsedCheckoutOptions = {}
): Promise<LapsedCheckoutSettlement> {
  const now = options.now ?? new Date();
  const keptUntilNow = cloudCancelledKeptUntil(now, options.cancelledRetentionDays);
  // The latest last transition whose kept window has ended by now.
  const lapsedBefore = new Date(2 * now.getTime() - keptUntilNow.getTime());
  const { rows } = await executeExomemSql`
    /* exomem-cloud:lapsed-checkouts */
    SELECT tenant.id AS tenant_id, tenant.owner_user_id, entitlement.source_revision,
           entitlement.provider_transaction_ref, entitlement.provider_environment,
           entitlement.provider_customer_ref
    FROM exomem_entitlements AS entitlement
    JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
    WHERE entitlement.source = 'paddle'
      AND entitlement.source_state = 'cancelled'
      AND entitlement.manual_suspended_at IS NULL
      AND entitlement.provider_transaction_ref IS NOT NULL
      AND entitlement.source_occurred_at <= ${lapsedBefore.toISOString()}::timestamptz
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND tenant.desired_state <> 'deleted'
      AND EXISTS (
        SELECT 1 FROM exomem_cloud_cells AS cell
        WHERE cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
      )
    ORDER BY random()
    LIMIT ${options.maxTenants ?? LAPSED_CHECKOUT_MAX_TENANTS}
  `;
  const result: LapsedCheckoutSettlement = { settled: 0, resumed: 0, waiting: 0 };
  if (rows.length === 0) return result;
  // One deadline for every Paddle call of the batch, so a slow Paddle costs
  // the cron at most the budget.
  const deadline = AbortSignal.timeout(options.budgetMs ?? CLOUD_SWEEP_PADDLE_BUDGET_MS);
  const bounded = paddleTransportUntil(deadline, options.transport);
  for (const row of rows as LapsedCheckout[]) {
    const outcome = deadline.aborted
      ? "waiting"
      : await settleLapsedCheckout(row, { ...options, transport: bounded, signal: deadline });
    result[outcome] += 1;
  }
  if (result.waiting > 0) {
    console.error("exomem-cloud: lapsed cells wait for their Paddle checkout to settle");
  }
  return result;
}

async function settleLapsedCheckout(
  row: LapsedCheckout,
  options: LapsedCheckoutOptions & { transport: PaddleTransport; signal: AbortSignal }
): Promise<keyof LapsedCheckoutSettlement> {
  if (!row.provider_environment) return "waiting";
  const bound = {
    userId: row.owner_user_id,
    tenantId: row.tenant_id,
    transactionId: row.provider_transaction_ref,
    environment: row.provider_environment,
  };
  try {
    const config = options.config ?? loadExomemPaddleTransactionConfig();
    const transaction = await (options.cancelTransaction ?? cancelExomemCheckoutTransaction)(
      bound,
      { config, transport: options.transport }
    );
    if (transaction.state === "completed") {
      if (!row.provider_customer_ref) return "waiting";
      const paid = await (options.recoverResubscription ?? recoverPaidResubscription)(
        {
          ...bound,
          customerRef: row.provider_customer_ref,
          sourceRevision: row.source_revision,
          paid: { subscriptionId: transaction.subscriptionId, customerId: transaction.customerId },
        },
        { transport: options.transport, signal: options.signal }
      );
      if (paid === "resumed") return "resumed";
    }
  } catch (error) {
    if (!(error instanceof ExomemBillingError && error.code === "EXOMEM_TRANSACTION_NOT_OWNED")) {
      return "waiting";
    }
  }
  const cleared = await executeExomemSql`
    /* exomem-cloud:lapsed-checkout-cleared */
    UPDATE exomem_entitlements
    SET provider_transaction_ref = NULL, updated_at = now()
    WHERE tenant_id = ${row.tenant_id}::uuid
      AND source_state = 'cancelled'
      AND provider_transaction_ref = ${row.provider_transaction_ref}
      AND source_revision IS NOT DISTINCT FROM ${row.source_revision}
    RETURNING tenant_id
  `;
  return cleared.rows.length === 1 ? "settled" : "waiting";
}

type CloudTenantMirror = {
  status: "active" | "suspended" | "deleted";
  desiredState: "running" | "suspended" | "deleted";
};

/**
 * Maps a Cloud cell's desired_state onto the vocabulary
 * `exomem_tenants.status`/`desired_state` actually admit (migration 0017:
 * `CHECK (status IN ('provisioning','active','suspended','deletion_pending','deleted'))`,
 * `CHECK (desired_state IN ('running','suspended','deleted'))`) — this round's
 * ruling that the tenant row mirrors the Cloud cell. Neither column has a
 * `read_only`/`grace` value, so `read_only` returns `null` and the mirror
 * write is skipped entirely: the tenant row keeps whatever it was last
 * mirrored to. Since `read_only` is only ever reached from a previously
 * `running` entitlement (D4's allow/deny branch), that leftover value is
 * exactly `active`/`running` (or admission's own initial `provisioning`/
 * `running`, if this is the tenant's first-ever reconcile) — which is also
 * the correct answer: `issueOAuthTokensFromCodeAtomic`'s
 * `status IN ('provisioning','active') AND desired_state = 'running'` gate
 * keeps issuing tokens while the cell still serves reads.
 */
function cloudDesiredStateToTenantMirror(target: CloudDesiredCellState): CloudTenantMirror | null {
  switch (target) {
    case "running":
      return { status: "active", desiredState: "running" };
    case "stopped":
      return { status: "suspended", desiredState: "suspended" };
    case "deleted":
      return { status: "deleted", desiredState: "deleted" };
    case "read_only":
      return null;
  }
}

/**
 * Reads one tenant's current entitlement and applies D4. Only reachable for
 * a tenant that already has a cell row (i.e. past admission) — a fresh
 * `awaiting_checkout` tenant's `stopped`/`deleted` transitions are D1's
 * concern (cloud-admission.ts), not this function's.
 *
 * The cell UPDATE is unconditional on the *current* desired_state matching
 * anything in particular (unlike admission's `stopped`-only guards), because
 * every transition this function makes is driven purely by the entitlement,
 * and the trigger is already a no-op when the target equals the current
 * value. It never touches an already-`deleted` row, so a Cloud cell that
 * reached `deleted` (account deletion, or the cancelled window elapsing)
 * stays deleted regardless of what the entitlement does afterwards.
 *
 * The tenant mirror write runs in the same transaction as the cell's
 * desired_state write (this round's ruling): both change together, or
 * neither does.
 */
export async function reconcileCloudCellDesiredState(
  tenantId: string,
  options: { cancelledRetentionDays?: number; now?: Date } = {}
): Promise<CloudDesiredCellState | null> {
  return withExomemTransaction(async (tx) => {
    const { rows } = await tx`
      /* exomem-cloud:reconcile-entitlement */
      SELECT entitlement.tenant_id, entitlement.source, entitlement.source_state,
             entitlement.manual_suspended_at, entitlement.source_occurred_at,
             entitlement.provider_transaction_ref,
             tenant.status AS tenant_status, tenant.desired_state AS tenant_desired_state
      FROM exomem_entitlements AS entitlement
      JOIN exomem_cloud_cells AS cell
        ON cell.tenant_id = entitlement.tenant_id
       AND cell.desired_state <> 'deleted'
      JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
      WHERE entitlement.tenant_id = ${tenantId}::uuid
      LIMIT 1
    `;
    const row = rows[0] as
      | (EntitlementRow & { tenant_status: string; tenant_desired_state: string })
      | undefined;
    if (!row) return null;

    // Account deletion (D4 table): a tenant whose deletion was confirmed has
    // its Cloud cell deleted, whatever its entitlement says. Its tenant row
    // stays `deletion_pending`, because billing deletion keys on that status
    // to cancel the provider subscription.
    const deletionPending = row.tenant_status === "deletion_pending";
    const accountDeleted =
      deletionPending || row.tenant_status === "deleted" || row.tenant_desired_state === "deleted";

    const sourceProjection = toSourceProjection(row);
    // An unrecognised source_state (pre-payment awaiting_checkout /
    // checkout_pending, or any value this module has never observed) never
    // reaches evaluateExomemEntitlement at all: every one of its five
    // recognised paddle branches allows at least a read, so guessing one
    // would risk repeating the finding-1 bug. `stopped` is the only D1/D4
    // answer for "the mapping does not recognise this state."
    const mapped: CloudDesiredCellState = accountDeleted
      ? "deleted"
      : sourceProjection
      ? desiredCloudCellState(
          {
            tenantId,
            manuallySuspended: row.manual_suspended_at !== null,
            sourceProjection,
            sourceOccurredAt: row.source_occurred_at ? new Date(row.source_occurred_at) : null,
          },
          options
        )
      : "stopped";
    // A lapsed export window deletes the cell only once no Paddle checkout
    // is bound to it: a resubscription opened inside the window could
    // otherwise be paid for a deleted cell. `settleLapsedCheckouts` clears
    // the binding once Paddle proves it cannot pay for the cell; until then
    // the cell stays read-only.
    const target: CloudDesiredCellState =
      mapped === "deleted" && !accountDeleted && row.provider_transaction_ref !== null
        ? "read_only"
        : mapped;

    // The cancellation-notice claim (migration 0057) is cleared the moment
    // the cell returns to running — security review finding 9: otherwise a
    // resubscription-then-cancel-again cycle finds the claim already set
    // from the first cancellation and silently sends no notice for the
    // second one.
    await tx`
      UPDATE exomem_cloud_cells
      SET desired_state = ${target},
          cancellation_notice_sent_at =
            CASE WHEN ${target} = 'running' THEN NULL ELSE cancellation_notice_sent_at END
      WHERE tenant_id = ${tenantId}::uuid
        AND desired_state <> 'deleted'
    `;

    // D2: the transaction that deletes the cell also revokes consent.
    if (target === "deleted") await revokeCloudResourceConsent(tx, tenantId);

    const mirror = deletionPending ? null : cloudDesiredStateToTenantMirror(target);
    if (mirror) {
      const deletedAt = mirror.status === "deleted" ? (options.now ?? new Date()) : null;
      await tx`
        UPDATE exomem_tenants
        SET status = ${mirror.status},
            desired_state = ${mirror.desiredState},
            deleted_at = ${deletedAt}
        WHERE id = ${tenantId}::uuid
      `;
    }

    return target;
  });
}

/**
 * Every non-deleted Cloud tenant that has an entitlement row (i.e. is past
 * admission) and has actually paid (or was never billed at all, i.e.
 * complimentary) — the sweep population `runBoundedCloudReconcile` walks.
 *
 * Pre-payment tenants (source = 'paddle' and source_state still
 * 'awaiting_checkout' or 'checkout_pending') are excluded entirely (security
 * review finding 1, BLOCKER): D1 owns their `stopped` -> `deleted` expiry
 * transition, and the periodic D4 sweep must never touch a row admission
 * hasn't activated yet.
 *
 * `ORDER BY random()` rather than a stable column: a bounded pass with a
 * deterministic order (e.g. created_at) always reselects the same oldest N
 * rows every tick once the fleet exceeds `limit`, permanently starving
 * whichever tenants sort last. Sampling a different random subset each tick
 * is what actually gives every tenant a chance to be reconciled over time.
 */
async function findActiveCloudTenantIds(limit: number): Promise<string[]> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:reconcile-sweep-population */
    SELECT cell.tenant_id
    FROM exomem_cloud_cells AS cell
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    WHERE cell.desired_state <> 'deleted'
      AND (
        -- A confirmed account deletion is swept even before payment.
        tenant.status IN ('deletion_pending', 'deleted')
        OR tenant.desired_state = 'deleted'
        OR NOT (
          entitlement.source = 'paddle'
          AND entitlement.source_state IN ('awaiting_checkout', 'checkout_pending')
        )
      )
    ORDER BY random()
    LIMIT ${limit}
  `;
  return rows.map((row) => String(row.tenant_id));
}

export type CloudReconcileResult = {
  reconciled: number;
  deleted: number;
  failed: number;
  /**
   * Lapsed cells that this tick's settlement reached and kept, because Paddle
   * did not settle their checkout in time; `null` when settlement itself
   * failed, so the count is unknown.
   */
  waitingForPaddle: number | null;
};

/**
 * The time-driven half of D4: no webhook fires when a cancelled tenant's
 * export window elapses, so a bounded periodic sweep is what actually turns
 * `read_only` into `deleted` on day 30 (and is the general safety net that
 * catches any entitlement change a webhook-triggered reconcile missed).
 * Idempotent per tenant — `reconcileCloudCellDesiredState` is a plain
 * re-derive-and-UPDATE, a no-op when nothing changed — so re-running this on
 * every tick, including overlapping ticks, is safe.
 */
export async function runBoundedCloudReconcile(
  options: {
    maxTenants?: number;
    cancelledRetentionDays?: number;
    reconcileTenant?: typeof reconcileCloudCellDesiredState;
    settleCheckouts?: typeof settleLapsedCheckouts;
    settleBudgetMs?: number;
  } = {}
): Promise<CloudReconcileResult> {
  const maxTenants = options.maxTenants ?? 200;
  const reconcileTenant = options.reconcileTenant ?? reconcileCloudCellDesiredState;
  const tenantIds = await findActiveCloudTenantIds(maxTenants);
  let reconciled = 0;
  let deleted = 0;
  let failed = 0;
  // Settlement runs first, within its own budget, so a lapsed cell it
  // releases is deleted in this same pass. Its failure stops no reconcile.
  let waitingForPaddle: number | null;
  try {
    waitingForPaddle = (
      await (options.settleCheckouts ?? settleLapsedCheckouts)({
        cancelledRetentionDays: options.cancelledRetentionDays,
        budgetMs: options.settleBudgetMs,
      })
    ).waiting;
  } catch {
    waitingForPaddle = null;
    console.error("exomem-cloud: lapsed checkout settlement failed");
  }
  for (const tenantId of tenantIds) {
    // Each tenant is isolated, as the expiry lane's are (security review
    // finding 8): one tenant that throws must not stop every other tenant's
    // reconcile, and account deletion relies on this sweep as its backstop.
    try {
      const target = await reconcileTenant(tenantId, {
        cancelledRetentionDays: options.cancelledRetentionDays,
      });
      if (target !== null) {
        reconciled += 1;
        if (target === "deleted") deleted += 1;
      }
    } catch {
      failed += 1;
      console.error("exomem-cloud: lifecycle reconcile failed for one tenant");
    }
  }
  return { reconciled, deleted, failed, waitingForPaddle };
}

export { CLOUD_AWAITING_CHECKOUT_EXPIRY_DAYS };
