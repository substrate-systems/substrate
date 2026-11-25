import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { loadOAuthSessionPolicy } from "../oauth-session-policy";

describe("OAuth session policy", () => {
  afterEach(() => mock.restoreAll());

  it("uses the shipped defaults when nothing is configured", () => {
    assert.deepEqual(loadOAuthSessionPolicy({}), {
      refreshIdleDays: 30,
      sessionMaxDays: 365,
      refreshReuseSeconds: 604800,
    });
  });

  it("reads configured values within their bounds, and 0 turns the reuse interval off", () => {
    assert.deepEqual(
      loadOAuthSessionPolicy({
        EXOMEM_OAUTH_REFRESH_IDLE_DAYS: "14",
        EXOMEM_OAUTH_SESSION_MAX_DAYS: "180",
        EXOMEM_OAUTH_REFRESH_REUSE_SECONDS: "0",
      }),
      { refreshIdleDays: 14, sessionMaxDays: 180, refreshReuseSeconds: 0 }
    );
  });

  it("reads a value above its maximum as the maximum, and warns", () => {
    const warn = mock.method(console, "warn", () => undefined);

    assert.deepEqual(
      loadOAuthSessionPolicy({
        EXOMEM_OAUTH_REFRESH_IDLE_DAYS: "400",
        EXOMEM_OAUTH_SESSION_MAX_DAYS: "5000",
        EXOMEM_OAUTH_REFRESH_REUSE_SECONDS: "3000000",
      }),
      { refreshIdleDays: 90, sessionMaxDays: 730, refreshReuseSeconds: 2592000 }
    );
    assert.equal(warn.mock.callCount(), 3);
  });

  it("reads a malformed day count as its default, and warns", () => {
    const warn = mock.method(console, "warn", () => undefined);

    assert.deepEqual(
      loadOAuthSessionPolicy({
        EXOMEM_OAUTH_REFRESH_IDLE_DAYS: "0",
        EXOMEM_OAUTH_SESSION_MAX_DAYS: "a year",
      }),
      { refreshIdleDays: 30, sessionMaxDays: 365, refreshReuseSeconds: 604800 }
    );
    assert.equal(warn.mock.callCount(), 2);
  });

  it("reads a malformed reuse interval as 0, strict replay, and warns", () => {
    const warn = mock.method(console, "warn", () => undefined);

    for (const value of ["off", "false", "-1", "-5", "Infinity", "1.5", "1e20"]) {
      assert.equal(
        loadOAuthSessionPolicy({ EXOMEM_OAUTH_REFRESH_REUSE_SECONDS: value }).refreshReuseSeconds,
        0,
        value
      );
    }
    assert.equal(warn.mock.callCount(), 7);
  });
});
