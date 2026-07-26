import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import {
  acquireCapacityProvisionClaim,
  expireCapacityProvisionClaims,
  releaseCapacityProvisionClaim,
  renewCapacityProvisionClaim,
  transitionCapacityAllocationAtomic,
} from "../capacity-store";

afterEach(() => __setExomemSqlForTests(null));

describe("capacity store", () => {
  it("transitions a locked allocation and its pool counters together", async () => {
    let query = "";
    __setExomemSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [{ id: "allocation-1" }] };
    });

    assert.equal(
      await transitionCapacityAllocationAtomic({ allocationId: "allocation-1", state: "occupied" }),
      true
    );
    assert.match(query, /FOR UPDATE OF allocation, pool/i);
    assert.match(query, /reserved_storage_bytes/i);
    assert.match(query, /reserved_runtime_slots/i);
    assert.match(query, /reserved_provision_slots/i);
    assert.match(query, /locked\.previous_state = 'reserved'/i);
  });

  it("acquires and renews claims under a pool lock, then releases and expires them in bounded batches", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
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
    assert.match(queries[3], /FOR UPDATE SKIP LOCKED/i);
    assert.match(queries[1], /lease_expires_at > now\(\)/i);
    assert.match(queries[2], /DELETE FROM exomem_capacity_claims/i);
    assert.match(queries[3], /LIMIT \?/i);
  });
});
