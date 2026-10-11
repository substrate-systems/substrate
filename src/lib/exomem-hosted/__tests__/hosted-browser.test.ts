import assert from "node:assert/strict";
import test from "node:test";
import { HostedBrowserError, friendlyHostedError } from "../hosted-browser";

test("an expired sign-in link says which of the two happened and what to do", () => {
  // Links last 15 minutes and work once. The bare cell message, "the access
  // link is invalid or unavailable", named neither the cause nor the cure, so a
  // stale link read as a broken product.
  const message = friendlyHostedError(
    new HostedBrowserError(
      { code: "ACCESS_TOKEN_INVALID", message: "the access link is invalid" },
      401
    )
  );
  assert.match(message, /expired or was already used/);
  assert.match(message, /Enter your email/);
});
