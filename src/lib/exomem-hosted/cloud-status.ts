/**
 * Exomem Cloud Home status (item 6 / task 3.7, `adopt-exomem-cloud-plain-cells`).
 *
 * `/api/exomem/status` (status/route.ts) returns this `LifecycleStatus` --
 * state, code, retryable -- and the browser's home-client.tsx and
 * home-state.ts render it.
 *
 * Reads only `exomem_cloud_cells` (desired_state, observed_state, ready,
 * last_error_code, hold_kind and the measured disk use) and
 * `exomem_entitlements.source_state`, to distinguish an unpaid invite from a
 * suspended cell -- never memory content, which this table has none of.
 */

import { executeExomemSql } from "./db";
import { awaitsFirstPayment } from "./entitlements";

export type LifecycleStatus = {
  state:
    | "awaiting_payment"
    | "preparing"
    | "ready"
    | "degraded"
    | "suspended"
    | "deletion_pending"
    | "deleted";
  // Every code the mapper below can return; the status route sends it as is.
  code:
    | "TENANT_PREPARING"
    | "PAYMENT_REQUIRED"
    | "CELL_PREPARING"
    | "CELL_READY"
    | "CELL_NOT_READY"
    | "CELL_PAUSED_FOR_EXPORT"
    | "CELL_PAUSED_FOR_HOLD"
    | "EXOMEM_SUSPENDED"
    | "EXOMEM_DELETED";
  requestId?: string;
  retryable: boolean;
};

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
  // cellctl's hold on the volume; `export` since migration 0066.
  hold_kind?: string | null;
  source_state: string | null;
};

/**
 * The cell's measured disk use (task 5.5): the latest backup or export Job's
 * report, never a plan allowance. Unknown until a Job has reported.
 */
export type CloudStorageObservation =
  | { state: "known"; used_bytes: number; filesystem_bytes: number; observed_at: string }
  | { state: "unknown" };

type CloudCellUsageRow = {
  desired_state: CloudCellStatusRow["desired_state"];
  used_bytes: string | null;
  filesystem_bytes: string | null;
  usage_observed_at: Date | null;
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
  // by manual suspension or a complimentary revocation, which never awaits a
  // first payment. A started checkout (`checkout_pending`) still awaits it.
  if (awaitsFirstPayment(row.source_state)) {
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
  // A hold stops the runtime: cellctl stops the cell (observed `stopping`,
  // then `stopped`) until the held work ends, and it reports `stopping` again
  // once it releases the hold, before the cell starts. None of this is a
  // fault. The owner asked for an export, so its pause has its own code; a
  // backup, upgrade, restore or import hold, and the `stopping` after any
  // hold, is maintenance that ends by itself.
  if (row.hold_kind === "export" && !row.ready) {
    return { state: "degraded", code: "CELL_PAUSED_FOR_EXPORT", retryable: true };
  }
  if ((row.hold_kind && !row.ready) || row.observed_state === "stopping") {
    return { state: "degraded", code: "CELL_PAUSED_FOR_HOLD", retryable: true };
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
  // Any other observed/desired mismatch (e.g. stopped without a hold, or
  // deleting, while desired_state calls for the cell to be live) is a
  // controller-side anomaly.
  return { state: "degraded", code: "CELL_NOT_READY", retryable: true };
}

function mapCloudCellToStorage(row: CloudCellUsageRow | undefined): CloudStorageObservation {
  if (!row || row.desired_state === "deleted") return { state: "unknown" };
  if (row.used_bytes === null || row.filesystem_bytes === null || !row.usage_observed_at) {
    return { state: "unknown" };
  }
  const used = Number(row.used_bytes);
  const total = Number(row.filesystem_bytes);
  // A size past JSON's exact integer range would be shown rounded; say unknown instead.
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(total)) return { state: "unknown" };
  return {
    state: "known",
    used_bytes: used,
    filesystem_bytes: total,
    observed_at: row.usage_observed_at.toISOString(),
  };
}

async function readNewestCloudCell(
  tenantId: string
): Promise<(CloudCellStatusRow & CloudCellUsageRow) | undefined> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:home-status */
    SELECT cell.desired_state, cell.observed_state, cell.ready, cell.last_error_code,
           cell.hold_kind, cell.used_bytes, cell.filesystem_bytes, cell.usage_observed_at,
           entitlement.source_state
    FROM exomem_cloud_cells AS cell
    LEFT JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
    WHERE cell.tenant_id = ${tenantId}::uuid
    ORDER BY cell.created_at DESC
    LIMIT 1
  `;
  return rows[0] as (CloudCellStatusRow & CloudCellUsageRow) | undefined;
}

export async function getOwnerCloudStatus(tenantId: string): Promise<LifecycleStatus> {
  return mapCloudCellToLifecycleStatus(await readNewestCloudCell(tenantId));
}

/** The status poll's database-only facts: lifecycle and measured storage. */
export async function getOwnerCloudHomeStatus(
  tenantId: string
): Promise<{ status: LifecycleStatus; storage: CloudStorageObservation }> {
  const row = await readNewestCloudCell(tenantId);
  return { status: mapCloudCellToLifecycleStatus(row), storage: mapCloudCellToStorage(row) };
}
