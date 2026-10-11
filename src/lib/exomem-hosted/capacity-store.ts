import { executeExomemSql, withExomemTransaction } from "./db";

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

/** Operator-safe pool accounting: no provider, allocation, or tenant identifiers escape. */
export async function getCapacityPoolStatus(): Promise<{
  storageCapacityBytes: number;
  reservedStorageBytes: number;
  runtimeCapacitySlots: number;
  reservedRuntimeSlots: number;
  provisionReservationCapacity: number;
  reservedProvisionSlots: number;
  provisionClaimCapacity: number;
  activeProvisionClaims: number;
  outstandingPaidInvites: number;
} | null> {
  const { rows } = await executeExomemSql`
    /* exomem:get-capacity-pool-status */
    SELECT pool.storage_capacity_bytes,
           pool.reserved_storage_bytes,
           pool.runtime_capacity_slots,
           pool.reserved_runtime_slots,
           pool.provision_reservation_capacity,
           pool.reserved_provision_slots,
           pool.provision_claim_capacity,
           count(claim.id)::integer AS active_claims,
           (
             SELECT count(*)::integer
             FROM exomem_invites AS invite
             WHERE invite.entitlement_source = 'paddle'
               AND NOT invite.self_serve
               AND invite.delivery_state IN ('pending', 'sent')
               AND invite.consumed_at IS NULL
               AND invite.revoked_at IS NULL
               AND invite.expires_at > now()
           ) AS outstanding_paid_invites
    FROM exomem_capacity_pools AS pool
    LEFT JOIN exomem_capacity_claims AS claim
      ON claim.pool_id = pool.id AND claim.lease_expires_at > now()
    WHERE pool.pool_key = 'exomem-hosted-alpha'
    GROUP BY pool.id
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    storageCapacityBytes: Number(row.storage_capacity_bytes),
    reservedStorageBytes: Number(row.reserved_storage_bytes),
    runtimeCapacitySlots: Number(row.runtime_capacity_slots),
    reservedRuntimeSlots: Number(row.reserved_runtime_slots),
    provisionReservationCapacity: Number(row.provision_reservation_capacity),
    reservedProvisionSlots: Number(row.reserved_provision_slots),
    provisionClaimCapacity: Number(row.provision_claim_capacity),
    activeProvisionClaims: Number(row.active_claims),
    outstandingPaidInvites: Number(row.outstanding_paid_invites),
  };
}
