import assert from "node:assert/strict";
import { it } from "node:test";
import { setupScreen } from "../setup-screen";

it("says the Exomem is ready only once its cell is, and shows progress until then", () => {
  // "Add Exomem to your assistant" opens with "Your Exomem is ready."
  assert.equal(setupScreen("connect", "ready"), "choose");
  assert.equal(setupScreen("connect", "preparing"), "preparing");
  assert.equal(setupScreen("connect-read-only", "degraded"), "preparing");
});
