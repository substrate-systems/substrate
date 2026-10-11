import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { configureCapacityPoolAtomic } from "../capacity-store";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

function setTestSql(sql: ExomemSql): void {
  __setExomemSqlForTests(sql);
  __setExomemTransactionForTests(async (callback) => callback(sql));
}

describe("capacity store", () => {
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
});
