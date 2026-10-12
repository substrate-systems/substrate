import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  invitationBlocked,
  invitationRequestBody,
  parseOperatorCapacity,
  requiresComplimentaryConfirmation,
} from "../operator-state";

const observed = {
  freePlaces: 2,
  freePlacesUnknownReason: null,
  observedSlots: 5,
  liveCells: 2,
  outstandingInvitations: 1,
  newestObservationAt: "2026-10-12T08:00:00.000Z",
};

describe("Exomem operator state", () => {
  it("never reads unknown capacity as zero free places", () => {
    const unobserved = {
      ...observed,
      freePlaces: null,
      freePlacesUnknownReason: "capacity_not_observed",
      observedSlots: 0,
    };
    assert.deepEqual(parseOperatorCapacity(unobserved), unobserved);
    assert.equal(parseOperatorCapacity({ ...unobserved, freePlacesUnknownReason: null }), null);
    assert.equal(parseOperatorCapacity({ ...observed, freePlaces: -1 }), null);
  });

  it("blocks every invitation while no place is free or capacity is unknown", () => {
    assert.equal(invitationBlocked(observed), false);
    assert.equal(invitationBlocked({ ...observed, freePlaces: 0 }), true);
    assert.equal(
      invitationBlocked({
        ...observed,
        freePlaces: null,
        freePlacesUnknownReason: "capacity_not_observed",
      }),
      true
    );
  });

  it("requires a separate confirmation only for covered (complimentary) access", () => {
    assert.equal(requiresComplimentaryConfirmation("standard", false), false);
    assert.equal(requiresComplimentaryConfirmation("friend", false), false);
    assert.equal(requiresComplimentaryConfirmation("covered", false), true);
    assert.equal(requiresComplimentaryConfirmation("covered", true), false);
  });

  it("sends an inviter's email only with a friend invitation, which alone notifies inviters", () => {
    const draft = {
      email: " friend@example.test ",
      inviterName: "Alex",
      inviterEmail: "alex@example.test",
      inviteeName: "Sam",
      note: "",
    };
    assert.deepEqual(invitationRequestBody({ ...draft, kind: "friend" }), {
      email: "friend@example.test",
      kind: "friend",
      inviterName: "Alex",
      inviterEmail: "alex@example.test",
      inviteeName: "Sam",
    });
    assert.equal("inviterEmail" in invitationRequestBody({ ...draft, kind: "covered" }), false);
  });
});
