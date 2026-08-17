import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { inviteRefusal } from "../invite-refusal";

describe("a refused invitation says which of the two things is wrong", () => {
  it("keeps the invitation's side when the service is the one not ready", () => {
    const refusal = inviteRefusal(true);

    // The defect this module exists to prevent: telling someone their
    // invitation is unusable directly above a 503 saying it is still valid.
    assert.doesNotMatch(refusal.lede, /fresh link/i);
    assert.match(refusal.lede, /invitation is fine/i);
    assert.equal(refusal.offerRetry, true);
  });

  it("still asks for a fresh link when the invitation itself is spent", () => {
    const refusal = inviteRefusal(false);

    assert.match(refusal.lede, /fresh link/i);
    assert.equal(refusal.offerRetry, false);
  });

  it("offers a retry only where one could succeed", () => {
    // A non-retryable refusal is final; a Try again button on it is a loop.
    assert.equal(inviteRefusal(false).offerRetry, false);
    assert.equal(inviteRefusal(true).offerRetry, true);
  });
});

describe("the invite page reads the refusal from the envelope", () => {
  const client = readFileSync(
    resolve(process.cwd(), "src/app/exomem/invite/invite-client.tsx"),
    "utf8"
  );

  it("carries `retryable` through instead of discarding it", () => {
    // `friendlyHostedError` flattens the error to a string, which is what threw
    // the distinction away in the first place.
    assert.match(client, /error instanceof HostedBrowserError && error\.retryable/);
    assert.match(client, /inviteRefusal\(state\.retryable\)/);
  });

  it("renders the module's lede rather than a literal of its own", () => {
    assert.match(client, /\{inviteRefusal\(state\.retryable\)\.lede\}/);
    assert.match(client, /inviteRefusal\(state\.retryable\)\.offerRetry/);
  });
});
