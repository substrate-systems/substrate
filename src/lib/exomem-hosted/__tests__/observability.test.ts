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

describe("start request events", () => {
  // The allowlist throws on an unknown name, and the start request emits after
  // its outcome is already committed -- an unregistered name would turn an
  // accepted request into a failure. Every event name the start path can emit
  // has to be registered.
  for (const event of [
    "access.start.accepted",
    "access.start.challenge_failed",
    "access.start.challenge_unavailable",
    "access.start.failed",
    "access.start.floor_overrun",
    "access.start.ran_before_response",
    "access.start.suppressed",
  ]) {
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
        event: "access.start.invented",
        outcome: "succeeded",
        requestId: "00000000-0000-4000-8000-000000000000",
      })
    );
  });
});

describe("email delivery events", () => {
  it("carries the kind, attempts and queue time, and no address passed as a label", () => {
    const event = buildOperationalEvent({
      event: "access.email.accepted",
      outcome: "succeeded",
      emailKind: "waitlist",
      attempts: 2,
      queueMs: 1840,
    });
    assert.equal(event.emailKind, "waitlist");
    assert.equal(event.attempts, 2);
    assert.equal(event.queueMs, 1840);

    const withAddress = buildOperationalEvent({
      event: "access.start.suppressed",
      outcome: "denied",
      limit: "person@example.com",
      emailKind: "person@example.com",
      queueMs: -1,
    });
    assert.equal(JSON.stringify(withAddress).includes("person@example.com"), false);
    assert.equal(withAddress.queueMs, undefined);
  });
});
