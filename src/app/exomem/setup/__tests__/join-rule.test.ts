import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinedSince, pollDelay, type ListedApp } from "../join-rule";

const BASELINE = "2026-10-12T10:00:00.000Z";
const app = (id: string, lastAuthorizedAt: string): ListedApp => ({
  id,
  displayName: id,
  platform: null,
  lastAuthorizedAt,
});

describe("the waiting step's join rule", () => {
  it("keeps waiting while every app was authorized before the first poll", () => {
    // An app connected yesterday must not announce itself as the one just added.
    assert.equal(joinedSince(BASELINE, [app("old", "2026-10-11T09:00:00.000Z")]), null);
  });

  it("names the app authorized after the first poll, the newest when two are", () => {
    const joined = joinedSince(BASELINE, [
      app("old", "2026-10-11T09:00:00.000Z"),
      app("first", "2026-10-12T10:01:00.000Z"),
      app("second", "2026-10-12T10:02:00.000Z"),
    ]);
    assert.equal(joined?.id, "second");
  });

  it("slows to every 30 seconds after 10 minutes, and never stops", () => {
    assert.equal(pollDelay(9 * 60_000), 3_000);
    assert.equal(pollDelay(10 * 60_000), 30_000);
    assert.equal(pollDelay(6 * 60 * 60_000), 30_000);
  });
});
