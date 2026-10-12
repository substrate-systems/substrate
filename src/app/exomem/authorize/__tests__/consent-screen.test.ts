import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConsentStep } from "@/lib/exomem-hosted/consent-state";
import { consentScreen, offersConnect } from "../consent-screen";

const view = (
  step: ConsentStep,
  facts: { alreadyConnected?: boolean; cellStarting?: boolean } = {}
) => ({
  step,
  alreadyConnected: facts.alreadyConnected ?? false,
  cellStarting: facts.cellStarting ?? false,
});

describe("the step the consent page opens on", () => {
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
      assert.equal(
        offersConnect(consentScreen(view(step))),
        step === "connect" || step === "connect-read-only",
        step
      );
    }
  });

  it("offers an app that is already connected the choice to keep it, even while the cell starts", () => {
    // Connect again replaces the app's access. Showing the plain Connect step would
    // hide that a grant already exists.
    assert.equal(
      consentScreen(view("connect", { alreadyConnected: true, cellStarting: true })),
      "again"
    );
  });

  it("still lets an owner connect while the cell starts, with the starting notice", () => {
    assert.equal(consentScreen(view("connect", { cellStarting: true })), "preparing");
  });
});
