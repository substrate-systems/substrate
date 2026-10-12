import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { subscribeLine } from "../subscribe-line";

describe("the subscribe line", () => {
  it("shows the price Paddle previews for checkout, and only when it is known", () => {
    assert.equal(
      subscribeLine(null),
      "Paddle shows the price at checkout. Then add it to your assistant."
    );
    assert.equal(
      subscribeLine({
        total: "€10.00",
        billingCycle: { interval: "month", frequency: 1 },
        includesTax: true,
      }),
      "€10.00 per month, including tax. Cancel any time through Paddle. Then add it to your assistant."
    );
    assert.equal(
      subscribeLine({
        total: "$27.00",
        billingCycle: { interval: "month", frequency: 3 },
        includesTax: false,
      }),
      "$27.00 every 3 months. Cancel any time through Paddle. Then add it to your assistant."
    );
  });

  it("names the app that opened the flow as the next step", () => {
    assert.equal(
      subscribeLine(null, "Claude"),
      "Paddle shows the price at checkout. Then Claude connects in one step."
    );
  });
});
