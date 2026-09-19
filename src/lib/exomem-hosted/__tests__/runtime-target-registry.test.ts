import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exomemHostedContractFixture } from "../agent-contract-fixture-0-77-0";
import { exomemContractFixture0770 } from "../gateway-contract-0-77-0";
import { getTrustedHostedRuntimeTarget } from "../runtime-target-registry";

describe("verified Hosted runtime target registry", () => {
  it("imports the independently verified release target without observing a cell", () => {
    const checked = getTrustedHostedRuntimeTarget("0.77.0");
    assert.ok(checked, "the verified release needs a provisioning target before its first cell");
    assert.equal(
      checked.runtimeTargetDigest,
      "631adffa955a19f6b3ff0c425ecc9ee903f1019130cfa6ec424388326d84e69b"
    );
    assert.equal(checked.target.sourceCommit, exomemHostedContractFixture.sourceCommit);
    assert.equal(checked.target.gatewayContractDigest, exomemContractFixture0770.digest);
    assert.equal(
      checked.target.compatibilityDigest,
      exomemHostedContractFixture.compatibility.compatibility_sha256
    );
    assert.notEqual(checked.target.gatewayContractDigest, checked.target.schemaDigest);
    assert.match(checked.verificationManifestDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(checked.verificationManifestDigest, checked.runtimeTargetDigest);
  });

  it("does not invent a target from a version label or accept alternate label spellings", () => {
    for (const release of ["0.74.0", "0.88.0", "v0.77.0", " 0.77.0", "0.77.0 ", ""]) {
      assert.equal(getTrustedHostedRuntimeTarget(release), null);
    }
  });

  it("does not let a caller mutate the next admission's reviewed target", () => {
    const checked = getTrustedHostedRuntimeTarget("0.77.0");
    assert.ok(checked);
    assert.ok(Object.isFrozen(checked));
    assert.ok(Object.isFrozen(checked.target));
    assert.throws(() => Object.assign(checked.target, { gatewayContractDigest: "0".repeat(64) }));
    assert.equal(
      getTrustedHostedRuntimeTarget("0.77.0")?.target.gatewayContractDigest,
      exomemContractFixture0770.digest
    );
  });
});
