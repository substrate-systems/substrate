import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXOMEM_ALPHA_BUNDLE, evaluateExomemEntitlement } from "../entitlements";

describe("evaluateExomemEntitlement", () => {
  it("gives complimentary alpha the normal active capability bundle", () => {
    const result = evaluateExomemEntitlement({
      lifecycleState: "ready",
      sourceProjection: { source: "complimentary", state: "active" },
      manuallySuspended: false,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });

    assert.equal(result.effectiveState, "active");
    assert.deepEqual(result.capabilities, EXOMEM_ALPHA_BUNDLE.capabilities);
    assert.deepEqual(result.resourceLimits, EXOMEM_ALPHA_BUNDLE.resourceLimits);
    assert.equal(result.decisions.read.allowed, true);
    assert.equal(result.decisions.write.allowed, true);
    assert.equal(result.decisions.export.allowed, true);
    assert.equal(result.decisions.billing.checkout.allowed, true);
    assert.equal(result.decisions.billing.portal.allowed, false);
  });

  it("maps Paddle active and trialing through the same provider-neutral shape", () => {
    for (const state of ["active", "trialing"] as const) {
      const result = evaluateExomemEntitlement({
        lifecycleState: "ready",
        sourceProjection: { source: "paddle", state },
        manuallySuspended: false,
        bundle: EXOMEM_ALPHA_BUNDLE,
      });

      assert.equal(result.effectiveState, "active");
      assert.equal(result.decisions.read.allowed, true);
      assert.equal(result.decisions.write.allowed, true);
      assert.equal(result.decisions.export.allowed, true);
      assert.equal(result.decisions.billing.portal.allowed, true);
    }
  });

  it("makes grace read/export-only with an explicit reason", () => {
    const result = evaluateExomemEntitlement({
      lifecycleState: "ready",
      sourceProjection: { source: "paddle", state: "past_due" },
      manuallySuspended: false,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });

    assert.equal(result.effectiveState, "grace");
    assert.deepEqual(result.capabilities, ["recall", "export"]);
    assert.deepEqual(result.decisions.write, {
      allowed: false,
      reason: "billing_grace",
    });
    assert.equal(result.decisions.billing.portal.allowed, true);
  });

  it("defines paused and cancelled policy without deleting data", () => {
    const paused = evaluateExomemEntitlement({
      lifecycleState: "ready",
      sourceProjection: { source: "paddle", state: "paused" },
      manuallySuspended: false,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });
    const cancelled = evaluateExomemEntitlement({
      lifecycleState: "ready",
      sourceProjection: { source: "paddle", state: "cancelled" },
      manuallySuspended: false,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });

    assert.equal(paused.effectiveState, "suspended");
    assert.equal(paused.decisions.read.allowed, true);
    assert.equal(paused.decisions.write.allowed, false);
    assert.equal(paused.decisions.export.allowed, true);
    assert.equal(cancelled.effectiveState, "cancelled");
    assert.equal(cancelled.decisions.read.allowed, true);
    assert.equal(cancelled.decisions.write.allowed, false);
    assert.equal(cancelled.decisions.export.allowed, true);
  });

  it("makes manual suspension dominate an active provider projection", () => {
    const result = evaluateExomemEntitlement({
      lifecycleState: "ready",
      sourceProjection: { source: "paddle", state: "active" },
      manuallySuspended: true,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });

    assert.equal(result.effectiveState, "suspended");
    assert.deepEqual(result.decisions.read, {
      allowed: false,
      reason: "manually_suspended",
    });
    assert.equal(result.decisions.write.allowed, false);
    assert.equal(result.decisions.export.allowed, false);
    assert.equal(result.decisions.billing.portal.allowed, true);
  });

  it("makes provisioning and deletion explicit lifecycle overrides", () => {
    const provisioning = evaluateExomemEntitlement({
      lifecycleState: "provisioning",
      sourceProjection: { source: "complimentary", state: "active" },
      manuallySuspended: false,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });
    const deleted = evaluateExomemEntitlement({
      lifecycleState: "deleted",
      sourceProjection: { source: "paddle", state: "active" },
      manuallySuspended: false,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });

    assert.equal(provisioning.effectiveState, "provisioning");
    assert.equal(provisioning.decisions.read.allowed, false);
    assert.equal(provisioning.decisions.billing.checkout.allowed, false);
    assert.equal(deleted.effectiveState, "deleted");
    assert.equal(deleted.decisions.read.allowed, false);
    assert.equal(deleted.decisions.billing.portal.allowed, false);
  });
});
