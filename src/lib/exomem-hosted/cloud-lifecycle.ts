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
  DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS,
} from "./cloud-config";

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

  const retentionDays = options.cancelledRetentionDays ?? DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS;
  if (!snapshot.sourceOccurredAt) return "read_only";
  const now = options.now ?? new Date();
  const elapsedMs = now.getTime() - snapshot.sourceOccurredAt.getTime();
  return elapsedMs >= retentionDays * 24 * 60 * 60 * 1000 ? "deleted" : "read_only";
}

type EntitlementRow = {
  tenant_id: string;
  source: "complimentary" | "paddle";
  source_state: string;
  manual_suspended_at: Date | null;
  source_occurred_at: Date | null;
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
    const target: CloudDesiredCellState = accountDeleted
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
  } = {}
): Promise<CloudReconcileResult> {
  const maxTenants = options.maxTenants ?? 200;
  const reconcileTenant = options.reconcileTenant ?? reconcileCloudCellDesiredState;
  const tenantIds = await findActiveCloudTenantIds(maxTenants);
  let reconciled = 0;
  let deleted = 0;
  let failed = 0;
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
  return { reconciled, deleted, failed };
}

export { CLOUD_AWAITING_CHECKOUT_EXPIRY_DAYS };
