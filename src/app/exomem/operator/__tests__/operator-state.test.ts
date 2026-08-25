import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  paidInviteHeadroom,
  parseOperatorCapacity,
  requiresComplimentaryConfirmation,
} from "../operator-state";

const capacity = {
  storageCapacityBytes: 20 * 1024 * 1024 * 1024,
  reservedStorageBytes: 5 * 1024 * 1024 * 1024,
  runtimeCapacitySlots: 4,
  reservedRuntimeSlots: 1,
  provisionReservationCapacity: 4,
  reservedProvisionSlots: 1,
  provisionClaimCapacity: 2,
  activeProvisionClaims: 0,
  outstandingPaidInvites: 1,
};

describe("Exomem operator state", () => {
  it("parses only complete non-negative capacity snapshots", () => {
    assert.deepEqual(parseOperatorCapacity(capacity), capacity);
    assert.equal(parseOperatorCapacity({ ...capacity, outstandingPaidInvites: -1 }), null);
    assert.equal(parseOperatorCapacity({ ...capacity, runtimeCapacitySlots: "4" }), null);
  });

  it("subtracts hard reservations and outstanding paid promises", () => {
    assert.equal(paidInviteHeadroom(capacity), 2);
    assert.equal(
      paidInviteHeadroom({
        ...capacity,
        reservedStorageBytes: capacity.storageCapacityBytes,
      }),
      0
    );
  });

  it("requires a separate confirmation only for complimentary access", () => {
    assert.equal(requiresComplimentaryConfirmation("paid", false), false);
    assert.equal(requiresComplimentaryConfirmation("complimentary", false), true);
    assert.equal(requiresComplimentaryConfirmation("complimentary", true), false);
  });
});
