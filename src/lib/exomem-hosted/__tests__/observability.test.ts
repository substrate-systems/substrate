import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOperationalEvent } from "../observability";

describe("operational event privacy", () => {
  it("drops reviewer credential submissions and reviewer-only identifiers from operational events", () => {
    const sentinel = "reviewer-submission-sensitive-sentinel";
    const event = buildOperationalEvent({
      event: "access.request.denied",
      outcome: "denied",
      username: sentinel,
      password: sentinel,
      usernameDigest: sentinel,
      ownerUserId: sentinel,
      reviewerTenantId: sentinel,
      fixtureContent: sentinel,
      failureDetail: sentinel,
    });

    assert.equal(JSON.stringify(event).includes(sentinel), false);
  });
});

describe("self-serve admission events", () => {
  // These names shipped in the route before they were registered here. The
  // allowlist throws on an unknown name, and the success-path emit ran *after*
  // the invite was minted and the setup link sent -- so a completed admission
  // was reported to the visitor as a failure, and retrying superseded the live
  // invite they had just been emailed. Every event name a route can emit has to
  // be registered.
  for (const event of ["access.self_serve.admitted", "access.self_serve.waitlisted"]) {
    it(`accepts ${event}`, () => {
      assert.doesNotThrow(() =>
        buildOperationalEvent({
          event,
          outcome: "succeeded",
          requestId: "00000000-0000-4000-8000-000000000000",
        })
      );
    });
  }

  it("still rejects an unregistered event name", () => {
    assert.throws(() =>
      buildOperationalEvent({
        event: "access.self_serve.invented",
        outcome: "succeeded",
        requestId: "00000000-0000-4000-8000-000000000000",
      })
    );
  });
});
