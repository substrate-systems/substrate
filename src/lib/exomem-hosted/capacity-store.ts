import { executeExomemSql, withExomemTransaction } from "./db";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";

export type CapacityAllocationState =
  | "reserved"
  | "occupied"
  | "uncertain"
  | "retained_storage"
  | "released";

const allocationStates = new Set<CapacityAllocationState>([
  "reserved",
  "occupied",
  "uncertain",
  "retained_storage",
  "released",
]);

function boundedLeaseSeconds(seconds: number): number {
  return Math.max(1, Math.min(Math.floor(seconds), 3_600));
}

class CapacityTransitionRejected extends Error {}

function transitionLabel(
  previous: CapacityAllocationState,
  next: CapacityAllocationState
): string | undefined {
  if (next === "released") return "any_to_released";
  const label = `${previous}_to_${next}`;
  return new Set([
    "reserved_to_uncertain",
    "uncertain_to_occupied",
    "occupied_to_retained_storage",
    "uncertain_to_retained_storage",
    "retained_storage_to_uncertain",
  ]).has(label)
    ? label
    : undefined;
}

function emitCapacityTransition(input: {
  operationId?: string;
  previous: CapacityAllocationState;
  next: CapacityAllocationState;
}): void {
  const transition = transitionLabel(input.previous, input.next);
  if (!transition) return;
  emitOperationalEvent(
    buildOperationalEvent({
      event: "lifecycle.capacity.transition",
      outcome: "succeeded",
      operationId: input.operationId,
      transition,
    })
  );
}

function emitCapacityClaim(input: {
  operationId: string;
  kind: "initial_provision" | "resume";
}): void {
  emitOperationalEvent(
    buildOperationalEvent({
      event: "lifecycle.capacity.claim",
      outcome: "succeeded",
      operationId: input.operationId,
      capacityBucket: "provision",
      claimKind: input.kind,
    })
  );
}

function capacityUsage(
  state: CapacityAllocationState,
  allocation: {
    storage_bytes: number;
    runtime_slots: number;
    provision_slots: number;
  }
) {
  return {
    storage: state === "released" ? 0 : Number(allocation.storage_bytes),
    runtime: ["reserved", "occupied", "uncertain"].includes(state)
      ? Number(allocation.runtime_slots)
      : 0,
    provision: state === "reserved" ? Number(allocation.provision_slots) : 0,
  };
}

/**
 * Transactional authority for allocation state and pool counters. A tenant and
 * optional lifecycle-operation fence prevent stale workers from changing a
 * reservation after ownership has moved.
 */
export async function transitionCapacityAllocationAtomic(input: {
  allocationId: string;
  state: CapacityAllocationState;
  tenantId?: string;
  operationId?: string;
}): Promise<boolean> {
  if (!allocationStates.has(input.state)) throw new Error("invalid capacity allocation state");
  try {
    const result = await withExomemTransaction(async (tx) => {
      const lockedResult = await tx`
        SELECT allocation.id, allocation.pool_id, allocation.storage_bytes, allocation.runtime_slots,
               allocation.provision_slots, allocation.state AS previous_state,
               pool.reserved_storage_bytes, pool.reserved_runtime_slots, pool.reserved_provision_slots,
               pool.storage_capacity_bytes, pool.runtime_capacity_slots, pool.provision_reservation_capacity
        FROM exomem_capacity_allocations AS allocation
        JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
        JOIN exomem_tenants AS tenant ON tenant.id = allocation.tenant_id
        WHERE allocation.id = ${input.allocationId}::uuid
          AND (${input.tenantId ?? null}::uuid IS NULL OR tenant.id = ${input.tenantId ?? null}::uuid)
          AND (${input.operationId ?? null}::uuid IS NULL OR allocation.operation_id = ${input.operationId ?? null}::uuid)
          AND (
            ${input.state} = 'released'
            OR (tenant.deleted_at IS NULL AND tenant.status <> 'deleted')
          )
        FOR UPDATE OF allocation, pool, tenant
      `;
      const locked = lockedResult.rows[0] as
        | {
            id: string;
            pool_id: string;
            storage_bytes: number;
            runtime_slots: number;
            provision_slots: number;
            previous_state: CapacityAllocationState;
            reserved_storage_bytes: number;
            reserved_runtime_slots: number;
            reserved_provision_slots: number;
            storage_capacity_bytes: number;
            runtime_capacity_slots: number;
            provision_reservation_capacity: number;
          }
        | undefined;
      if (!locked) return { succeeded: false };
      const allowed =
        locked.previous_state === input.state ||
        (locked.previous_state === "reserved" &&
          ["occupied", "uncertain", "released"].includes(input.state)) ||
        (["occupied", "uncertain"].includes(locked.previous_state) &&
          ["occupied", "uncertain", "retained_storage", "released"].includes(input.state)) ||
        (locked.previous_state === "retained_storage" &&
          ["uncertain", "retained_storage", "released"].includes(input.state));
      if (!allowed) return { succeeded: false };
      const oldUsage = capacityUsage(locked.previous_state, locked);
      const nextUsage = capacityUsage(input.state, locked);
      const next = {
        storage: Number(locked.reserved_storage_bytes) - oldUsage.storage + nextUsage.storage,
        runtime: Number(locked.reserved_runtime_slots) - oldUsage.runtime + nextUsage.runtime,
        provision:
          Number(locked.reserved_provision_slots) - oldUsage.provision + nextUsage.provision,
      };
      const delta = {
        storage: next.storage - Number(locked.reserved_storage_bytes),
        runtime: next.runtime - Number(locked.reserved_runtime_slots),
        provision: next.provision - Number(locked.reserved_provision_slots),
      };
      if (
        next.storage < 0 ||
        next.runtime < 0 ||
        next.provision < 0 ||
        (delta.storage > 0 && next.storage > Number(locked.storage_capacity_bytes)) ||
        (delta.runtime > 0 && next.runtime > Number(locked.runtime_capacity_slots)) ||
        (delta.provision > 0 && next.provision > Number(locked.provision_reservation_capacity))
      )
        return { succeeded: false };
      const poolResult = await tx`
        UPDATE exomem_capacity_pools
        SET reserved_storage_bytes = ${next.storage}, reserved_runtime_slots = ${next.runtime},
            reserved_provision_slots = ${next.provision}, updated_at = now()
        WHERE id = ${locked.pool_id}::uuid
        RETURNING id
      `;
      if (!poolResult.rows[0]) throw new CapacityTransitionRejected();
      const allocationResult = await tx`
        UPDATE exomem_capacity_allocations
        SET state = ${input.state},
            occupied_at = CASE WHEN ${input.state} = 'occupied' THEN COALESCE(occupied_at, now()) ELSE occupied_at END,
            released_at = CASE WHEN ${input.state} = 'released' THEN now() ELSE NULL END,
            updated_at = now()
        WHERE id = ${locked.id}::uuid
        RETURNING id
      `;
      if (!allocationResult.rows[0]) throw new CapacityTransitionRejected();
      return { succeeded: true, previous: locked.previous_state };
    });
    if (result.succeeded) {
      emitCapacityTransition({
        operationId: input.operationId,
        previous: result.previous as CapacityAllocationState,
        next: input.state,
      });
    }
    return result.succeeded;
  } catch (error) {
    if (error instanceof CapacityTransitionRejected) return false;
    throw error;
  }
}

/**
 * Moves one durable allocation through its allowed lifecycle while adjusting
 * the denormalized pool counters under the same row locks.
 */
// Kept solely to make this high-risk SQL rewrite easy to compare during review.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function transitionCapacityAllocationAtomicLegacy(input: {
  allocationId: string;
  state: CapacityAllocationState;
}): Promise<boolean> {
  if (!allocationStates.has(input.state)) throw new Error("invalid capacity allocation state");
  const { rows } = await executeExomemSql`
    /* exomem:transition-capacity-allocation */
    WITH locked AS (
      SELECT allocation.id, allocation.pool_id, allocation.storage_bytes,
             allocation.runtime_slots, allocation.provision_slots,
             allocation.state AS previous_state
      FROM exomem_capacity_allocations AS allocation
      JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
      WHERE allocation.id = ${input.allocationId}::uuid
      FOR UPDATE OF allocation, pool
    ), updated AS (
      UPDATE exomem_capacity_allocations AS allocation
      SET state = ${input.state},
          provision_slots = CASE WHEN ${input.state} = 'reserved' THEN allocation.provision_slots ELSE 0 END,
          occupied_at = CASE
            WHEN ${input.state} = 'occupied' THEN COALESCE(allocation.occupied_at, now())
            ELSE allocation.occupied_at
          END,
          released_at = CASE WHEN ${input.state} = 'released' THEN now() ELSE NULL END,
          updated_at = now()
      FROM locked
      WHERE allocation.id = locked.id
        AND (
          (locked.previous_state = 'reserved' AND ${input.state} IN ('occupied', 'uncertain', 'released'))
          OR (locked.previous_state IN ('occupied', 'uncertain') AND ${input.state} IN ('occupied', 'uncertain', 'retained_storage', 'released'))
          OR (locked.previous_state = 'retained_storage' AND ${input.state} IN ('retained_storage', 'released'))
        )
      RETURNING allocation.id, allocation.pool_id
    )
    UPDATE exomem_capacity_pools AS pool
    SET reserved_storage_bytes = pool.reserved_storage_bytes
          - CASE WHEN locked.previous_state <> 'released' THEN locked.storage_bytes ELSE 0 END
          + CASE WHEN ${input.state} <> 'released' THEN locked.storage_bytes ELSE 0 END,
        reserved_runtime_slots = pool.reserved_runtime_slots
          - CASE WHEN locked.previous_state IN ('reserved', 'occupied', 'uncertain') THEN locked.runtime_slots ELSE 0 END
          + CASE WHEN ${input.state} IN ('reserved', 'occupied', 'uncertain') THEN locked.runtime_slots ELSE 0 END,
        reserved_provision_slots = pool.reserved_provision_slots
          - CASE WHEN locked.previous_state = 'reserved' THEN locked.provision_slots ELSE 0 END
          + CASE WHEN ${input.state} = 'reserved' THEN locked.provision_slots ELSE 0 END,
        updated_at = now()
    FROM locked
    JOIN updated ON updated.id = locked.id
    WHERE pool.id = locked.pool_id
      AND pool.reserved_storage_bytes
            - CASE WHEN locked.previous_state <> 'released' THEN locked.storage_bytes ELSE 0 END
            + CASE WHEN ${input.state} <> 'released' THEN locked.storage_bytes ELSE 0 END
          <= pool.storage_capacity_bytes
      AND pool.reserved_runtime_slots
            - CASE WHEN locked.previous_state IN ('reserved', 'occupied', 'uncertain') THEN locked.runtime_slots ELSE 0 END
            + CASE WHEN ${input.state} IN ('reserved', 'occupied', 'uncertain') THEN locked.runtime_slots ELSE 0 END
          <= pool.runtime_capacity_slots
      AND pool.reserved_provision_slots
            - CASE WHEN locked.previous_state = 'reserved' THEN locked.provision_slots ELSE 0 END
            + CASE WHEN ${input.state} = 'reserved' THEN locked.provision_slots ELSE 0 END
          <= pool.provision_reservation_capacity
    RETURNING updated.id
  `;
  return rows.length === 1;
}

/** Reconciles durable occupancy before an operator enables or changes a pool. */
export async function configureCapacityPoolAtomic(input: {
  poolKey: string;
  storageCapacityBytes: number;
  runtimeCapacitySlots: number;
  provisionReservationCapacity: number;
  provisionClaimCapacity: number;
}): Promise<boolean> {
  if (
    [
      input.storageCapacityBytes,
      input.runtimeCapacitySlots,
      input.provisionReservationCapacity,
      input.provisionClaimCapacity,
    ].some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("invalid capacity totals");
  }
  return withExomemTransaction(async (tx) => {
    const poolResult = await tx`
      SELECT id
      FROM exomem_capacity_pools
      WHERE pool_key = ${input.poolKey}
      FOR UPDATE
    `;
    const pool = poolResult.rows[0] as { id: string } | undefined;
    if (!pool) return false;
    const occupancyResult = await tx`
      SELECT
        COALESCE(SUM(storage_bytes) FILTER (WHERE state <> 'released'), 0)::bigint AS storage_bytes,
        COALESCE(SUM(runtime_slots) FILTER (WHERE state IN ('reserved', 'occupied', 'uncertain')), 0)::integer AS runtime_slots,
        COALESCE(SUM(provision_slots) FILTER (WHERE state = 'reserved'), 0)::integer AS provision_slots
      FROM exomem_capacity_allocations
      WHERE pool_id = ${pool.id}::uuid
    `;
    const occupancy = occupancyResult.rows[0] as
      | {
          storage_bytes: number | string;
          runtime_slots: number | string;
          provision_slots: number | string;
        }
      | undefined;
    const claimsResult = await tx`
      SELECT count(*)::integer AS active_claims
      FROM exomem_capacity_claims
      WHERE pool_id = ${pool.id}::uuid AND lease_expires_at > now()
    `;
    const activeClaims = Number(
      (claimsResult.rows[0] as { active_claims?: number } | undefined)?.active_claims ?? 0
    );
    if (
      !occupancy ||
      Number(occupancy.storage_bytes) > input.storageCapacityBytes ||
      Number(occupancy.runtime_slots) > input.runtimeCapacitySlots ||
      Number(occupancy.provision_slots) > input.provisionReservationCapacity ||
      activeClaims > input.provisionClaimCapacity
    ) {
      return false;
    }
    const updated = await tx`
      UPDATE exomem_capacity_pools
      SET storage_capacity_bytes = ${input.storageCapacityBytes},
          runtime_capacity_slots = ${input.runtimeCapacitySlots},
          provision_reservation_capacity = ${input.provisionReservationCapacity},
          provision_claim_capacity = ${input.provisionClaimCapacity},
          reserved_storage_bytes = ${Number(occupancy.storage_bytes)},
          reserved_runtime_slots = ${Number(occupancy.runtime_slots)},
          reserved_provision_slots = ${Number(occupancy.provision_slots)},
          configured_at = now(), updated_at = now()
      WHERE id = ${pool.id}::uuid
      RETURNING id
    `;
    return Boolean(updated.rows[0]);
  });
}

/** The locked pool row serializes the active-claim count and insertion. */
export async function acquireCapacityProvisionClaim(input: {
  allocationId: string;
  operationId: string;
  kind: "initial_provision" | "resume";
  leaseOwner: string;
  leaseSeconds: number;
}): Promise<boolean> {
  const leaseSeconds = boundedLeaseSeconds(input.leaseSeconds);
  try {
    return await withExomemTransaction(async (tx) => {
      const lockedResult = await tx`
        SELECT allocation.id AS allocation_id, allocation.pool_id, allocation.tenant_id,
               pool.provision_claim_capacity
        FROM exomem_capacity_allocations AS allocation
        JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
        JOIN exomem_tenants AS tenant ON tenant.id = allocation.tenant_id
        WHERE allocation.id = ${input.allocationId}::uuid
          AND (
            (${input.kind} = 'initial_provision' AND allocation.state IN ('reserved', 'uncertain'))
            OR (${input.kind} = 'resume' AND allocation.state = 'uncertain')
          )
          AND tenant.deleted_at IS NULL AND tenant.status <> 'deleted'
        FOR UPDATE OF allocation, pool, tenant
      `;
      const locked = lockedResult.rows[0] as
        | {
            allocation_id: string;
            pool_id: string;
            tenant_id: string;
            provision_claim_capacity: number;
          }
        | undefined;
      if (!locked) return false;

      const operationResult = await tx`
        SELECT id
        FROM exomem_lifecycle_operations
        WHERE id = ${input.operationId}::uuid AND tenant_id = ${locked.tenant_id}::uuid
        FOR UPDATE
      `;
      if (!operationResult.rows[0]) return false;

      const existingResult = await tx`
        SELECT id, operation_id, lease_owner, lease_expires_at
        FROM exomem_capacity_claims
        WHERE allocation_id = ${locked.allocation_id}::uuid
        FOR UPDATE
      `;
      const existing = existingResult.rows[0] as
        | { id: string; operation_id: string; lease_owner: string; lease_expires_at: Date | string }
        | undefined;
      if (existing) {
        const renewed = await tx`
          UPDATE exomem_capacity_claims
          SET lease_expires_at = now() + (${leaseSeconds} * interval '1 second')
          WHERE id = ${existing.id}::uuid
            AND operation_id = ${input.operationId}::uuid
            AND lease_owner = ${input.leaseOwner}
            AND lease_expires_at > now()
          RETURNING id
        `;
        if (renewed.rows[0]) return true;
        await tx`DELETE FROM exomem_capacity_claims WHERE id = ${existing.id}::uuid AND lease_expires_at <= now()`;
      }

      const activeResult = await tx`
        SELECT count(*)::integer AS active_claims
        FROM exomem_capacity_claims
        WHERE pool_id = ${locked.pool_id}::uuid AND lease_expires_at > now()
      `;
      const activeClaims = Number(
        (activeResult.rows[0] as { active_claims?: number } | undefined)?.active_claims ?? 0
      );
      if (activeClaims >= Number(locked.provision_claim_capacity)) return false;

      const inserted = await tx`
        INSERT INTO exomem_capacity_claims (
          pool_id, allocation_id, operation_id, claim_kind, lease_owner, lease_expires_at
        ) VALUES (
          ${locked.pool_id}::uuid, ${locked.allocation_id}::uuid, ${input.operationId}::uuid,
          ${input.kind}, ${input.leaseOwner}, now() + (${leaseSeconds} * interval '1 second')
        )
        RETURNING id
      `;
      return Boolean(inserted.rows[0]);
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505")
      return false;
    throw error;
  }
}

/** One authority transaction: claim admission precedes any capacity transition. */
export async function acquireCapacityProviderWorkAtomic(input: {
  operationId: string;
  leaseOwner: string;
  kind: "initial_provision" | "resume";
  leaseSeconds: number;
}): Promise<"acquired" | "exhausted" | "conflict" | "legacy"> {
  const leaseSeconds = boundedLeaseSeconds(input.leaseSeconds);
  const result = await withExomemTransaction(async (tx) => {
    const legacy = await tx`
      SELECT tenant.legacy_unmetered
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
      WHERE operation.id = ${input.operationId}::uuid AND operation.state = 'running'
        AND operation.lease_owner = ${input.leaseOwner} AND operation.lease_expires_at > now()
        AND operation.fence_generation = tenant.fence_generation
      FOR UPDATE OF operation, tenant
    `;
    if (!legacy.rows[0]) return "conflict";
    if ((legacy.rows[0] as { legacy_unmetered?: boolean }).legacy_unmetered === true)
      return "legacy";
    const { rows } = await tx`
      SELECT operation.id AS operation_id, allocation.id AS allocation_id, allocation.pool_id,
             allocation.state, allocation.storage_bytes, allocation.runtime_slots,
             allocation.provision_slots, pool.reserved_storage_bytes, pool.reserved_runtime_slots,
             pool.reserved_provision_slots, pool.storage_capacity_bytes, pool.runtime_capacity_slots,
             pool.provision_reservation_capacity, pool.provision_claim_capacity
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
      JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = tenant.id
      JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
      WHERE operation.id = ${input.operationId}::uuid
        AND operation.state = 'running' AND operation.lease_owner = ${input.leaseOwner}
        AND operation.lease_expires_at > now() AND operation.fence_generation = tenant.fence_generation
        AND tenant.deleted_at IS NULL AND tenant.status <> 'deleted'
      FOR UPDATE OF operation, tenant, allocation, pool
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return "conflict";
    const state = String(row.state) as CapacityAllocationState;
    const expected = input.kind === "initial_provision" ? "reserved" : "retained_storage";
    if (state !== expected && state !== "uncertain") return "conflict";
    const claim = await tx`
      SELECT id, operation_id FROM exomem_capacity_claims
      WHERE allocation_id = ${String(row.allocation_id)}::uuid FOR UPDATE
    `;
    const existing = claim.rows[0] as { id: string; operation_id: string } | undefined;
    if (existing && existing.operation_id !== input.operationId) return "exhausted";
    if (!existing) {
      const count = await tx`
        SELECT count(*)::integer AS active FROM exomem_capacity_claims
        WHERE pool_id = ${String(row.pool_id)}::uuid AND lease_expires_at > now()
      `;
      if (
        Number((count.rows[0] as { active?: number })?.active ?? 0) >=
        Number(row.provision_claim_capacity)
      )
        return "exhausted";
    }
    const allocation = {
      storage_bytes: Number(row.storage_bytes),
      runtime_slots: Number(row.runtime_slots),
      provision_slots: Number(row.provision_slots),
    };
    const oldUsage = capacityUsage(state, allocation);
    const nextUsage = capacityUsage("uncertain", allocation);
    const next = {
      storage: Number(row.reserved_storage_bytes) - oldUsage.storage + nextUsage.storage,
      runtime: Number(row.reserved_runtime_slots) - oldUsage.runtime + nextUsage.runtime,
      provision: Number(row.reserved_provision_slots) - oldUsage.provision + nextUsage.provision,
    };
    if (
      (next.storage > Number(row.reserved_storage_bytes) &&
        next.storage > Number(row.storage_capacity_bytes)) ||
      (next.runtime > Number(row.reserved_runtime_slots) &&
        next.runtime > Number(row.runtime_capacity_slots)) ||
      (next.provision > Number(row.reserved_provision_slots) &&
        next.provision > Number(row.provision_reservation_capacity))
    )
      return "exhausted";
    if (state !== "uncertain") {
      await tx`UPDATE exomem_capacity_pools SET reserved_storage_bytes = ${next.storage}, reserved_runtime_slots = ${next.runtime}, reserved_provision_slots = ${next.provision}, updated_at = now() WHERE id = ${String(row.pool_id)}::uuid`;
      await tx`UPDATE exomem_capacity_allocations SET state = 'uncertain', updated_at = now() WHERE id = ${String(row.allocation_id)}::uuid`;
    }
    if (existing)
      await tx`UPDATE exomem_capacity_claims SET lease_owner = ${input.leaseOwner}, lease_expires_at = now() + (${leaseSeconds} * interval '1 second') WHERE id = ${existing.id}::uuid`;
    else
      await tx`INSERT INTO exomem_capacity_claims (pool_id, allocation_id, operation_id, claim_kind, lease_owner, lease_expires_at) VALUES (${String(row.pool_id)}::uuid, ${String(row.allocation_id)}::uuid, ${input.operationId}::uuid, ${input.kind}, ${input.leaseOwner}, now() + (${leaseSeconds} * interval '1 second'))`;
    return "acquired";
  });
  if (result === "acquired") emitCapacityClaim(input);
  return result;
}

export async function markUnboundCellDestroyedAtomic(input: {
  operationId: string;
  leaseOwner: string;
  cellId: string;
}): Promise<boolean> {
  const result = await withExomemTransaction(async (tx) => {
    const locked = await tx`
      SELECT operation.operation_type, operation.tenant_id, allocation.id AS allocation_id,
             allocation.operation_id AS allocation_operation_id, allocation.pool_id,
             allocation.state, allocation.storage_bytes, allocation.runtime_slots, allocation.provision_slots,
             pool.reserved_storage_bytes, pool.reserved_runtime_slots, pool.reserved_provision_slots
      FROM exomem_lifecycle_operations AS operation
      JOIN exomem_tenants AS tenant ON tenant.id = operation.tenant_id
      JOIN exomem_cells AS cell ON cell.id = ${input.cellId}::uuid AND cell.tenant_id = tenant.id
      LEFT JOIN exomem_capacity_allocations AS allocation ON allocation.tenant_id = tenant.id
      LEFT JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
      WHERE operation.id = ${input.operationId}::uuid AND operation.state = 'running'
        AND operation.lease_owner = ${input.leaseOwner} AND operation.lease_expires_at > now()
        AND operation.fence_generation = tenant.fence_generation AND cell.routing_state <> 'bound'
        AND tenant.bound_cell_id IS DISTINCT FROM cell.id
      FOR UPDATE OF operation, tenant, cell, allocation, pool
    `;
    const row = locked.rows[0] as Record<string, unknown> | undefined;
    if (!row) return { completed: false, released: false };
    if (
      row.operation_type === "provision" &&
      (!row.allocation_id ||
        row.allocation_operation_id !== input.operationId ||
        row.state === "released")
    ) {
      return { completed: false, released: false };
    }
    await tx`
      UPDATE exomem_cells SET lifecycle_state = 'deleted', routing_state = 'retiring', desired_state = 'deleted',
        provider_ref = NULL, private_endpoint_ciphertext = NULL, service_credential_ciphertext = NULL,
        service_credential_digest = NULL, pending_service_credential_ciphertext = NULL,
        pending_service_credential_digest = NULL, pending_credential_version = NULL,
        retired_at = COALESCE(retired_at, now()), updated_at = now()
      WHERE id = ${input.cellId}::uuid
    `;
    if (row.operation_type !== "provision" || !row.allocation_id)
      return { completed: true, released: false };
    const old = capacityUsage(row.state as CapacityAllocationState, {
      storage_bytes: Number(row.storage_bytes),
      runtime_slots: Number(row.runtime_slots),
      provision_slots: Number(row.provision_slots),
    });
    await tx`
      UPDATE exomem_capacity_pools SET reserved_storage_bytes = reserved_storage_bytes - ${old.storage},
        reserved_runtime_slots = reserved_runtime_slots - ${old.runtime},
        reserved_provision_slots = reserved_provision_slots - ${old.provision}, updated_at = now()
      WHERE id = ${String(row.pool_id)}::uuid
    `;
    await tx`UPDATE exomem_capacity_allocations SET state = 'released', released_at = now(), updated_at = now() WHERE id = ${String(row.allocation_id)}::uuid`;
    await tx`DELETE FROM exomem_capacity_claims WHERE allocation_id = ${String(row.allocation_id)}::uuid`;
    return {
      completed: true,
      released: true,
      previous: row.state as CapacityAllocationState,
    };
  });
  if (result.released) {
    emitCapacityTransition({
      operationId: input.operationId,
      previous: result.previous as CapacityAllocationState,
      next: "released",
    });
  }
  return result.completed;
}

/** Legacy CTE implementation retained temporarily for migration review. */
// Kept solely to make this high-risk SQL rewrite easy to compare during review.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function acquireCapacityProvisionClaimLegacy(input: {
  allocationId: string;
  operationId: string;
  kind: "initial_provision" | "resume";
  leaseOwner: string;
  leaseSeconds: number;
}): Promise<boolean> {
  const leaseSeconds = boundedLeaseSeconds(input.leaseSeconds);
  const { rows } = await executeExomemSql`
    /* exomem:acquire-capacity-provision-claim */
    WITH locked AS (
      SELECT allocation.id AS allocation_id, allocation.pool_id
      FROM exomem_capacity_allocations AS allocation
      JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
      WHERE allocation.id = ${input.allocationId}::uuid
        AND allocation.state = 'reserved'
      FOR UPDATE OF allocation, pool
    ), available AS (
      SELECT locked.allocation_id, locked.pool_id
      FROM locked
      JOIN exomem_capacity_pools AS pool ON pool.id = locked.pool_id
      WHERE EXISTS (
          SELECT 1 FROM exomem_capacity_claims AS own
          WHERE own.allocation_id = locked.allocation_id
            AND own.operation_id = ${input.operationId}::uuid
            AND own.lease_owner = ${input.leaseOwner}
            AND own.lease_expires_at > now()
        )
        OR (
          SELECT count(*)
          FROM exomem_capacity_claims AS claim
          WHERE claim.pool_id = locked.pool_id AND claim.lease_expires_at > now()
        ) < pool.provision_claim_capacity
    ), claim AS (
      INSERT INTO exomem_capacity_claims (
        pool_id, allocation_id, operation_id, claim_kind, lease_owner, lease_expires_at
      )
      SELECT pool_id, allocation_id, ${input.operationId}::uuid, ${input.kind}, ${input.leaseOwner},
             now() + (${leaseSeconds} * interval '1 second')
      FROM available
      ON CONFLICT (allocation_id) DO UPDATE
      SET operation_id = EXCLUDED.operation_id,
          claim_kind = EXCLUDED.claim_kind,
          lease_owner = EXCLUDED.lease_owner,
          lease_expires_at = EXCLUDED.lease_expires_at
      WHERE exomem_capacity_claims.lease_expires_at <= now()
         OR (exomem_capacity_claims.operation_id = EXCLUDED.operation_id
             AND exomem_capacity_claims.lease_owner = EXCLUDED.lease_owner)
      RETURNING id
    )
    SELECT id FROM claim
  `;
  return rows.length === 1;
}

export async function renewCapacityProvisionClaim(input: {
  allocationId: string;
  operationId: string;
  leaseOwner: string;
  leaseSeconds: number;
}): Promise<boolean> {
  const leaseSeconds = boundedLeaseSeconds(input.leaseSeconds);
  const { rows } = await executeExomemSql`
    /* exomem:renew-capacity-provision-claim */
    UPDATE exomem_capacity_claims
    SET lease_expires_at = now() + (${leaseSeconds} * interval '1 second')
    WHERE allocation_id = ${input.allocationId}::uuid
      AND operation_id = ${input.operationId}::uuid
      AND lease_owner = ${input.leaseOwner}
      AND lease_expires_at > now()
    RETURNING id
  `;
  return rows.length === 1;
}

export async function releaseCapacityProvisionClaim(input: {
  allocationId: string;
  operationId: string;
  leaseOwner: string;
}): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:release-capacity-provision-claim */
    DELETE FROM exomem_capacity_claims
    WHERE allocation_id = ${input.allocationId}::uuid
      AND operation_id = ${input.operationId}::uuid
      AND lease_owner = ${input.leaseOwner}
    RETURNING id
  `;
  return rows.length === 1;
}

export async function expireCapacityProvisionClaims(limit = 100): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1_000));
  const { rows } = await executeExomemSql`
    /* exomem:expire-capacity-provision-claims */
    WITH expired AS (
      SELECT id
      FROM exomem_capacity_claims
      WHERE lease_expires_at <= now()
      ORDER BY lease_expires_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${boundedLimit}
    )
    DELETE FROM exomem_capacity_claims AS claim
    USING expired
    WHERE claim.id = expired.id
    RETURNING claim.id
  `;
  return rows.length;
}
