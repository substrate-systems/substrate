import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { loadOAuthSessionPolicy } from "../oauth-session-policy";

describe("OAuth session policy", () => {
  afterEach(() => mock.restoreAll());

  it("uses the shipped defaults when nothing is configured", () => {
    assert.deepEqual(loadOAuthSessionPolicy({}), {
      refreshIdleDays: 30,
      sessionMaxDays: 365,
      refreshReuseSeconds: 60,
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
        EXOMEM_OAUTH_REFRESH_REUSE_SECONDS: "3600",
      }),
      { refreshIdleDays: 90, sessionMaxDays: 730, refreshReuseSeconds: 300 }
    );
    assert.equal(warn.mock.callCount(), 3);
  });

  it("reads a malformed or out-of-range value as the default, and warns", () => {
    const warn = mock.method(console, "warn", () => undefined);

    assert.deepEqual(
      loadOAuthSessionPolicy({
        EXOMEM_OAUTH_REFRESH_IDLE_DAYS: "0",
        EXOMEM_OAUTH_SESSION_MAX_DAYS: "a year",
        EXOMEM_OAUTH_REFRESH_REUSE_SECONDS: "-5",
      }),
      { refreshIdleDays: 30, sessionMaxDays: 365, refreshReuseSeconds: 60 }
    );
    assert.equal(warn.mock.callCount(), 3);
  });
});
