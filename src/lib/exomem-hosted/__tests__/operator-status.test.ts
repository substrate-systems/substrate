import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  demoteExomemAgentContractCandidate,
  listExomemAgentContractStatus,
} from "../agent-contract-store";
import { getCapacityPoolStatus } from "../capacity-store";
import { __setExomemSqlForTests, __setExomemTransactionForTests } from "../db";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

describe("operator status getters", () => {
  it("returns only coarse capacity totals and active claim count", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          storage_capacity_bytes: "10",
          reserved_storage_bytes: "4",
          runtime_capacity_slots: 3,
          reserved_runtime_slots: 1,
          provision_reservation_capacity: 2,
          reserved_provision_slots: 1,
          provision_claim_capacity: 2,
          active_claims: 1,
        },
      ],
    }));

    assert.deepEqual(await getCapacityPoolStatus(), {
      storageCapacityBytes: 10,
      reservedStorageBytes: 4,
      runtimeCapacitySlots: 3,
      reservedRuntimeSlots: 1,
      provisionReservationCapacity: 2,
      reservedProvisionSlots: 1,
      provisionClaimCapacity: 2,
      activeProvisionClaims: 1,
    });
  });

  it("lists contract digests and retires only a live contract", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT id, state")) {
        return {
          rows: [
            {
              id: "018f2d91-7c42-7000-8000-000000000021",
              state: "live",
              command_fingerprint: "a".repeat(64),
              schema_digest: "b".repeat(64),
              compatibility_digest: "c".repeat(64),
            },
          ],
        };
      }
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000021" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));

    assert.deepEqual(await listExomemAgentContractStatus(), [
      {
        id: "018f2d91-7c42-7000-8000-000000000021",
        state: "live",
        commandFingerprint: "a".repeat(64),
        schemaDigest: "b".repeat(64),
        compatibilityDigest: "c".repeat(64),
      },
    ]);
    assert.equal(
      await demoteExomemAgentContractCandidate("018f2d91-7c42-7000-8000-000000000021"),
      true
    );
    assert.match(queries[1], /pg_advisory_xact_lock\(/i);
    assert.doesNotMatch(queries[1], /pg_advisory_xact_lock_shared/i);
    assert.match(queries[2], /SET state = 'retired', retired_at = now\(\)/i);
    assert.match(queries[2], /AND state = 'live'/i);
  });
});
