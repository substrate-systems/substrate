import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOperationalEvent } from "../observability";

describe("capacity observability", () => {
  it("keeps only exact capacity enums and drops a sensitive sentinel", () => {
    const sentinel = "provider-endpoint-token-sensitive-sentinel";
    const event = buildOperationalEvent({
      event: "lifecycle.capacity.claim",
      outcome: "succeeded",
      capacityBucket: "runtime",
      transition: "reserved_to_uncertain",
      claimKind: "initial_provision",
      tenantId: sentinel,
      requestId: sentinel,
    });

    assert.deepEqual(event, {
      timestamp: event.timestamp,
      event: "lifecycle.capacity.claim",
      outcome: "succeeded",
      capacityBucket: "runtime",
      transition: "reserved_to_uncertain",
      claimKind: "initial_provision",
    });
    assert.equal(JSON.stringify(event).includes(sentinel), false);
  });
});
