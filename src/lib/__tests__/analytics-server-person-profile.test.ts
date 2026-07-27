import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("server analytics person processing", () => {
  it("disables person profiles for resolved and unresolved events", async () => {
    const analyticsServer = await import("../analytics-server");
    assert.equal(typeof analyticsServer.buildServerEventProperties, "function");

    const resolved = analyticsServer.buildServerEventProperties("anon-browser-123", {
      product: "supporter",
      $process_person_profile: true,
    });
    const unresolved = analyticsServer.buildServerEventProperties(null, {
      job: "test",
      outcome: "completed",
    });

    assert.deepEqual(resolved, {
      product: "supporter",
      server_side: true,
      identity_resolved: true,
      $process_person_profile: false,
    });
    assert.deepEqual(unresolved, {
      job: "test",
      outcome: "completed",
      server_side: true,
      identity_resolved: false,
      $process_person_profile: false,
    });
  });
});
