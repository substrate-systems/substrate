import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  acquireCapacityProvisionClaim,
  configureCapacityPoolAtomic,
  expireCapacityProvisionClaims,
  releaseCapacityProvisionClaim,
  renewCapacityProvisionClaim,
  transitionCapacityAllocationAtomic,
} from "../capacity-store";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

function setTestSql(sql: ExomemSql): void {
  __setExomemSqlForTests(sql);
  __setExomemTransactionForTests(async (callback) => callback(sql));
}

describe("capacity store", () => {
  it("transitions a locked allocation and its pool counters together", async () => {
    let query = "";
    setTestSql(async (strings) => {
      query = strings.join("?");
      if (query.includes("previous_state")) {
        return {
          rows: [
            {
              id: "allocation-1",
              pool_id: "pool-1",
              storage_bytes: 5,
              runtime_slots: 1,
              provision_slots: 1,
              previous_state: "reserved",
              reserved_storage_bytes: 5,
              reserved_runtime_slots: 1,
              reserved_provision_slots: 1,
              storage_capacity_bytes: 5,
              runtime_capacity_slots: 1,
              provision_reservation_capacity: 1,
            },
          ],
        };
      }
      return { rows: [{ id: "allocation-1" }] };
    });

    assert.equal(
      await transitionCapacityAllocationAtomic({ allocationId: "allocation-1", state: "occupied" }),
      true
    );
    assert.match(query, /UPDATE exomem_capacity_allocations/i);
    assert.match(query, /provision_slots = CASE WHEN \? = 'reserved' THEN/i);
  });

  it("acquires and renews claims under a pool lock, then releases and expires them in bounded batches", async () => {
    const queries: string[] = [];
    setTestSql(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT allocation.id AS allocation_id")) {
        return {
          rows: [{ allocation_id: "allocation-1", pool_id: "pool-1", provision_claim_capacity: 1 }],
        };
      }
      if (query.includes("SELECT id, operation_id")) return { rows: [] };
      if (query.includes("active_claims")) return { rows: [{ active_claims: 0 }] };
      return { rows: [{ id: "claim-1" }] };
    });

    assert.equal(
      await acquireCapacityProvisionClaim({
        allocationId: "allocation-1",
        operationId: "operation-1",
        kind: "initial_provision",
        leaseOwner: "worker-a",
        leaseSeconds: 60,
      }),
      true
    );
    assert.equal(
      await renewCapacityProvisionClaim({
        allocationId: "allocation-1",
        operationId: "operation-1",
        leaseOwner: "worker-a",
        leaseSeconds: 60,
      }),
      true
    );
    assert.equal(
      await releaseCapacityProvisionClaim({
        allocationId: "allocation-1",
        operationId: "operation-1",
        leaseOwner: "worker-a",
      }),
      true
    );
    assert.equal(await expireCapacityProvisionClaims(25), 1);

    assert.match(queries[0], /FOR UPDATE OF allocation, pool/i);
    assert.match(queries[0], /provision_claim_capacity/i);
    assert.equal(
      queries.some((query) => /FOR UPDATE SKIP LOCKED/i.test(query)),
      true
    );
    assert.equal(
      queries.some((query) => /lease_expires_at > now\(\)/i.test(query)),
      true
    );
    assert.equal(
      queries.some((query) => /DELETE FROM exomem_capacity_claims/i.test(query)),
      true
    );
    assert.equal(
      queries.some((query) => /LIMIT \?/i.test(query)),
      true
    );
  });

  it("recomputes durable occupancy before configuring a pool", async () => {
    const queries: string[] = [];
    setTestSql(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT id\n      FROM exomem_capacity_pools"))
        return { rows: [{ id: "pool-1" }] };
      if (query.includes("SUM(storage_bytes)"))
        return { rows: [{ storage_bytes: 5, runtime_slots: 1, provision_slots: 1 }] };
      if (query.includes("active_claims")) return { rows: [{ active_claims: 1 }] };
      return { rows: [{ id: "pool-1" }] };
    });

    assert.equal(
      await configureCapacityPoolAtomic({
        poolKey: "exomem-hosted-alpha",
        storageCapacityBytes: 5,
        runtimeCapacitySlots: 1,
        provisionReservationCapacity: 1,
        provisionClaimCapacity: 1,
      }),
      true
    );
    assert.equal(
      queries.some((query) => /FOR UPDATE/i.test(query)),
      true
    );
    assert.equal(
      queries.some((query) => /SUM\(storage_bytes\)/i.test(query)),
      true
    );
    assert.equal(
      queries.some((query) => /configured_at = now\(\)/i.test(query)),
      true
    );
  });

  it("allows a tenant-fenced resume claim after runtime is reacquired", async () => {
    const queries: string[] = [];
    setTestSql(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT allocation.id AS allocation_id")) {
        return {
          rows: [
            {
              allocation_id: "allocation-1",
              pool_id: "pool-1",
              tenant_id: "tenant-1",
              provision_claim_capacity: 1,
            },
          ],
        };
      }
      if (query.includes("SELECT id, operation_id")) return { rows: [] };
      if (query.includes("active_claims")) return { rows: [{ active_claims: 0 }] };
      return { rows: [{ id: "row-1" }] };
    });

    assert.equal(
      await acquireCapacityProvisionClaim({
        allocationId: "allocation-1",
        operationId: "resume-operation-1",
        kind: "resume",
        leaseOwner: "worker-a",
        leaseSeconds: 60,
      }),
      true
    );
    assert.equal(
      queries.some((query) => /allocation\.state = 'uncertain'/i.test(query)),
      true
    );
    assert.equal(
      queries.some(
        (query) => /exomem_lifecycle_operations/i.test(query) && /tenant_id = \?::uuid/i.test(query)
      ),
      true
    );
  });
});
