import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
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
          outstanding_paid_invites: 2,
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
      outstandingPaidInvites: 2,
    });
  });
});
