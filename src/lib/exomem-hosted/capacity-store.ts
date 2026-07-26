import { executeExomemSql } from "./db";

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

/**
 * Moves one durable allocation through its allowed lifecycle while adjusting
 * the denormalized pool counters under the same row locks.
 */
export async function transitionCapacityAllocationAtomic(input: {
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

export async function acquireCapacityProvisionClaim(input: {
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
