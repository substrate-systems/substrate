/**
 * Exomem Cloud Home status (item 6 / task 3.7, `adopt-exomem-cloud-plain-cells`).
 *
 * Additive and gated: nothing here is called from any hosted code path.
 * `/api/exomem/status` (status/route.ts) calls this only under
 * `EXOMEM_CLOUD_ENABLED`, in place of `getOwnerLifecycleStatus`
 * (reconcile-runtime.ts). Returns the exact same `LifecycleStatus` shape
 * hosted status already uses -- state, code, retryable -- so the browser's
 * home-client.tsx and home-state.ts need no Cloud-specific branching at all;
 * it already renders any tenant whose status maps onto that vocabulary.
 *
 * Reads only `exomem_cloud_cells` (desired_state, observed_state, ready,
 * last_error_code) and `exomem_entitlements.source_state`, to distinguish an
 * unpaid invite from a suspended cell -- never memory content, which this
 * table has none of.
 */

import { executeExomemSql } from "./db";
import type { LifecycleStatus } from "./reconciler";

type CloudCellStatusRow = {
  desired_state: "running" | "read_only" | "stopped" | "deleted";
  observed_state:
    | "pending"
    | "provisioning"
    | "running"
    | "read_only"
    | "stopping"
    | "stopped"
    | "deleting"
    | "deleted"
    | "failed"
    | null;
  ready: boolean;
  last_error_code: string | null;
  source_state: string | null;
};

export function mapCloudCellToLifecycleStatus(
  row: CloudCellStatusRow | undefined
): LifecycleStatus {
  // No cell row at all is not a state D1 ever leaves a Cloud-admitted tenant
  // in -- redeemCloudInviteAtomic and admitFirstCloudOAuthInviteAtomic both
  // create the row in the same transaction as the tenant itself. Treat it as
  // "preparing" defensively rather than surfacing an internal inconsistency.
  if (!row) return { state: "preparing", code: "TENANT_PREPARING", retryable: true };
  if (row.desired_state === "deleted") {
    return { state: "deleted", code: "EXOMEM_DELETED", retryable: false };
  }
  // D1: a paid invite's cell starts `stopped` and stays that way, holding its
  // capacity slot, until checkout completes -- distinct from a cell stopped
  // by manual suspension or a complimentary revocation, which never has an
  // `awaiting_checkout` entitlement.
  if (row.source_state === "awaiting_checkout") {
    return { state: "awaiting_payment", code: "PAYMENT_REQUIRED", retryable: false };
  }
  if (row.desired_state === "stopped") {
    return { state: "suspended", code: "EXOMEM_SUSPENDED", retryable: false };
  }
  // From here, desired_state is "running" or "read_only" (D4's allow/allow or
  // allow/deny branches) -- the tenant is entitled to the cell existing.
  if (row.observed_state === "failed" || row.last_error_code) {
    return { state: "degraded", code: "CELL_NOT_READY", retryable: true };
  }
  if (row.observed_state === row.desired_state && row.ready) {
    return { state: "ready", code: "CELL_READY", retryable: false };
  }
  if (
    row.observed_state === null ||
    row.observed_state === "pending" ||
    row.observed_state === "provisioning"
  ) {
    return { state: "preparing", code: "CELL_PREPARING", retryable: true };
  }
  // Any other observed/desired mismatch (e.g. stopping or deleting while
  // desired_state calls for the cell to be live) is a transitional or
  // controller-side anomaly -- surfaced the same way hosted surfaces one.
  return { state: "degraded", code: "CELL_NOT_READY", retryable: true };
}

export async function getOwnerCloudStatus(tenantId: string): Promise<LifecycleStatus> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:home-status */
    SELECT cell.desired_state, cell.observed_state, cell.ready, cell.last_error_code,
           entitlement.source_state
    FROM exomem_cloud_cells AS cell
    LEFT JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
    WHERE cell.tenant_id = ${tenantId}::uuid
    ORDER BY cell.created_at DESC
    LIMIT 1
  `;
  return mapCloudCellToLifecycleStatus(rows[0] as CloudCellStatusRow | undefined);
}
