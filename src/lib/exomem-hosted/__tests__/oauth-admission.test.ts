import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CapacityAdmissionLedger, EXOMEM_ALPHA_CAPACITY } from "../oauth-admission";

describe("OAuth first-invite capacity admission", () => {
  it("admits exactly one concurrent final-slot invite and leaves the other reusable", async () => {
    const ledger = new CapacityAdmissionLedger({
      storageCapacityBytes: EXOMEM_ALPHA_CAPACITY.storageBytes,
      runtimeCapacitySlots: 1,
      provisionReservationCapacity: 1,
      provisionClaimCapacity: 1,
      configured: true,
    });
    const [first, second] = await Promise.all([
      Promise.resolve(ledger.reserve("invite-1")),
      Promise.resolve(ledger.reserve("invite-2")),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal(ledger.isReserved("invite-1") || ledger.isReserved("invite-2"), true);
    assert.equal(ledger.isReserved(first ? "invite-2" : "invite-1"), false);
  });

  it("separates queued reservations from the bounded in-flight provider claim", () => {
    const ledger = new CapacityAdmissionLedger({
      storageCapacityBytes: EXOMEM_ALPHA_CAPACITY.storageBytes * 2,
      runtimeCapacitySlots: 2,
      provisionReservationCapacity: 2,
      provisionClaimCapacity: 1,
      configured: true,
    });
    assert.equal(ledger.reserve("invite-1"), true);
    assert.equal(ledger.reserve("invite-2"), true);
    assert.equal(ledger.claim("invite-1"), true);
    assert.equal(ledger.claim("invite-2"), false);
    ledger.releaseClaim("invite-1");
    assert.equal(ledger.claim("invite-2"), true);
  });
});
