import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consentStep, type ConsentStep } from "../consent-state";

// One row per account state the consent page branches on. A wrong row is a visitor
// shown a Connect button the server refuses, or a dead end where a next step exists.
const CASES: Array<{
  account: string;
  effectiveState: string;
  sourceState: string;
  step: ConsentStep;
}> = [
  {
    account: "paid invite, checkout not started",
    effectiveState: "provisioning",
    sourceState: "awaiting_checkout",
    step: "subscribe",
  },
  {
    account: "paid invite, checkout started",
    effectiveState: "provisioning",
    sourceState: "checkout_pending",
    step: "subscribe",
  },
  {
    account: "paid, cell still being prepared",
    effectiveState: "provisioning",
    sourceState: "active",
    step: "connect",
  },
  { account: "paid and active", effectiveState: "active", sourceState: "active", step: "connect" },
  { account: "trialing", effectiveState: "active", sourceState: "trialing", step: "connect" },
  {
    account: "complimentary",
    effectiveState: "active",
    sourceState: "complimentary_active",
    step: "connect",
  },
  {
    account: "payment failed (grace)",
    effectiveState: "grace",
    sourceState: "past_due",
    step: "connect-read-only",
  },
  { account: "cancelled", effectiveState: "cancelled", sourceState: "cancelled", step: "ended" },
  { account: "paused", effectiveState: "suspended", sourceState: "paused", step: "paused" },
  {
    account: "manually suspended paid owner",
    effectiveState: "suspended",
    sourceState: "active",
    step: "suspended",
  },
  {
    account: "revoked complimentary owner",
    effectiveState: "suspended",
    sourceState: "complimentary_active",
    step: "suspended",
  },
  {
    account: "deleted",
    effectiveState: "deleted",
    sourceState: "deletion_cancelled",
    step: "sign-in",
  },
];

describe("consentStep routes each account state to its next step", () => {
  for (const { account, effectiveState, sourceState, step } of CASES) {
    it(`${account} -> ${step}`, () => {
      assert.equal(consentStep({ effectiveState, sourceState }), step);
    });
  }

  it("renders the signed-out view when there is no usable session", () => {
    assert.equal(consentStep(null), "sign-in");
  });
});
