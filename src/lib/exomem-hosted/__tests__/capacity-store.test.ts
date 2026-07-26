import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  acquireCapacityProviderWorkAtomic,
  acquireCapacityProvisionClaim,
  configureCapacityPoolAtomic,
  expireCapacityProvisionClaims,
  markUnboundCellDestroyedAtomic,
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
    assert.doesNotMatch(query, /provision_slots\s*=/i);
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

  it("allows a capacity-reducing suspension while the pool is conservatively over capacity", async () => {
    setTestSql(async (strings) => {
      const query = strings.join("?");
      if (query.includes("previous_state")) {
        return {
          rows: [
            {
              id: "allocation-1",
              pool_id: "pool-1",
              storage_bytes: 5,
              runtime_slots: 1,
              provision_slots: 0,
              previous_state: "occupied",
              reserved_storage_bytes: 5,
              reserved_runtime_slots: 2,
              reserved_provision_slots: 0,
              storage_capacity_bytes: 1,
              runtime_capacity_slots: 1,
              provision_reservation_capacity: 0,
            },
          ],
        };
      }
      return { rows: [{ id: "allocation-1" }] };
    });

    assert.equal(
      await transitionCapacityAllocationAtomic({
        allocationId: "allocation-1",
        state: "retained_storage",
      }),
      true
    );
  });

  it("emits capacity transitions only after their transaction commits", async () => {
    const lines: string[] = [];
    const originalInfo = console.info;
    let committed = false;
    const sql: ExomemSql = async (strings) => {
      const query = strings.join("?");
      if (query.includes("previous_state")) {
        return {
          rows: [
            {
              id: "018f2d91-7c42-7000-8000-000000000061",
              pool_id: "018f2d91-7c42-7000-8000-000000000062",
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
      return { rows: [{ id: "row-1" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => {
      const result = await callback(sql);
      committed = true;
      return result;
    });
    console.info = ((line: string) => {
      assert.equal(committed, true);
      lines.push(line);
    }) as typeof console.info;

    try {
      assert.equal(
        await transitionCapacityAllocationAtomic({
          allocationId: "018f2d91-7c42-7000-8000-000000000061",
          operationId: "018f2d91-7c42-7000-8000-000000000063",
          state: "uncertain",
        }),
        true
      );
    } finally {
      console.info = originalInfo;
    }

    const event = JSON.parse(lines[0] ?? "{}");
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(event.event, "lifecycle.capacity.transition");
    assert.equal(event.outcome, "succeeded");
    assert.equal(event.operationId, "018f2d91-7c42-7000-8000-000000000063");
    assert.equal(event.transition, "reserved_to_uncertain");
  });

  it("fails closed for an unmarked allocation-less tenant and emits claims after commit", async () => {
    const operationId = "018f2d91-7c42-7000-8000-000000000064";
    const sql: ExomemSql = async (strings) => {
      const query = strings.join("?");
      if (query.includes("tenant.legacy_unmetered")) return { rows: [{ legacy_unmetered: false }] };
      if (query.includes("allocation.id AS allocation_id")) {
        return {
          rows: [
            {
              allocation_id: "018f2d91-7c42-7000-8000-000000000061",
              pool_id: "018f2d91-7c42-7000-8000-000000000062",
              state: "reserved",
              storage_bytes: 5,
              runtime_slots: 1,
              provision_slots: 1,
              reserved_storage_bytes: 5,
              reserved_runtime_slots: 1,
              reserved_provision_slots: 1,
              storage_capacity_bytes: 5,
              runtime_capacity_slots: 1,
              provision_reservation_capacity: 1,
              provision_claim_capacity: 1,
            },
          ],
        };
      }
      if (query.includes("SELECT id, operation_id")) return { rows: [] };
      if (query.includes("count(*)::integer AS active")) return { rows: [{ active: 0 }] };
      return { rows: [{ id: "row-1" }] };
    };
    const noAllocation: ExomemSql = async (strings) =>
      strings.join("?").includes("tenant.legacy_unmetered")
        ? { rows: [{ legacy_unmetered: false }] }
        : { rows: [] };
    setTestSql(noAllocation);
    assert.equal(
      await acquireCapacityProviderWorkAtomic({
        operationId,
        leaseOwner: "worker-a",
        kind: "initial_provision",
        leaseSeconds: 60,
      }),
      "conflict"
    );

    const lines: string[] = [];
    const originalInfo = console.info;
    let committed = false;
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => {
      const result = await callback(sql);
      committed = true;
      return result;
    });
    console.info = ((line: string) => {
      assert.equal(committed, true);
      lines.push(line);
    }) as typeof console.info;
    try {
      assert.equal(
        await acquireCapacityProviderWorkAtomic({
          operationId,
          leaseOwner: "worker-a",
          kind: "initial_provision",
          leaseSeconds: 60,
        }),
        "acquired"
      );
    } finally {
      console.info = originalInfo;
    }
    const event = JSON.parse(lines[0] ?? "{}");
    assert.equal(event.event, "lifecycle.capacity.claim");
    assert.equal(event.operationId, operationId);
    assert.equal(event.capacityBucket, "provision");
    assert.equal(event.claimKind, "initial_provision");
  });

  it("does not delete a provision candidate when its allocation is missing", async () => {
    const queries: string[] = [];
    setTestSql(async (strings) => {
      queries.push(strings.join("?"));
      return {
        rows: [
          {
            operation_type: "provision",
            allocation_id: null,
          },
        ],
      };
    });

    assert.equal(
      await markUnboundCellDestroyedAtomic({
        operationId: "018f2d91-7c42-7000-8000-000000000064",
        leaseOwner: "worker-a",
        cellId: "018f2d91-7c42-7000-8000-000000000065",
      }),
      false
    );
    assert.equal(
      queries.some((query) => /UPDATE exomem_cells/i.test(query)),
      false
    );
  });
});
