import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consentSections } from "../consent-audience";
import type { ConsentStep } from "../consent-state";

describe("the consent page offers one path per step", () => {
  it("leads a signed-out visitor with sign-in, then the invitation, and keeps reviewer access last", () => {
    // Hugo, an active owner, read the old page as a sign-up form: it led with the
    // invitation email and a reviewer form, and sign-in was a small link. Before
    // that, on 2026-08-16, the reviewer form sat above the invitation field.
    assert.deepEqual(consentSections({ step: "sign-in", reviewerEnabled: true }), [
      "sign-in",
      "invitation",
      "reviewer",
    ]);
  });

  it("omits the reviewer path entirely when the flag is off", () => {
    assert.deepEqual(consentSections({ step: "sign-in", reviewerEnabled: false }), [
      "sign-in",
      "invitation",
    ]);
  });

  it("offers Connect only in the steps the consent gate accepts", () => {
    // `/oauth/authorize/complete` refuses every other state, so a Connect button
    // there could only send the visitor back to this page.
    const steps: ConsentStep[] = [
      "sign-in",
      "subscribe",
      "connect",
      "connect-read-only",
      "ended",
      "paused",
      "suspended",
    ];
    for (const step of steps) {
      const offersConnect = consentSections({ step, reviewerEnabled: true }).includes("connect");
      assert.equal(offersConnect, step === "connect" || step === "connect-read-only", step);
    }
  });

  it("tells an owner in the payment grace period why Exomem is read-only before they connect", () => {
    assert.deepEqual(consentSections({ step: "connect-read-only", reviewerEnabled: false }), [
      "payment-failed",
      "connect",
    ]);
  });
});
