import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { getTrustedHostedRuntimeTarget } from "../runtime-target-registry";

function describeTarget(overrides: Record<string, string> = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("EXOMEM_") && key !== "DATABASE_URL"
    )
  );
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/hosted-cluster-rehearsal.ts", "--describe-runtime-target"],
    { encoding: "utf8", env: { ...env, NODE_ENV: "test", ...overrides }, timeout: 20_000 }
  );
}

describe("connected rehearsal runtime selection", () => {
  it("selects the repaired release from its reviewed target", () => {
    const result = describeTarget({ EXOMEM_REHEARSAL_RELEASE: "0.89.0" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), getTrustedHostedRuntimeTarget("0.89.0")!.target);
  });
  it("describes the reviewed target without credentials, database or cluster effects", () => {
    const result = describeTarget();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), getTrustedHostedRuntimeTarget("0.89.0")!.target);
  });

  it("refuses an unreviewed release before asking for database credentials", () => {
    const result = describeTarget({ EXOMEM_REHEARSAL_RELEASE: "99.0.0" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reviewed runtime target/);
    assert.doesNotMatch(result.stderr, /Missing required environment/);
  });

  it("rejects every mismatching identity field in the paired runtime target", () => {
    const target = getTrustedHostedRuntimeTarget("0.89.0")!.target;
    for (const key of Object.keys(target)) {
      const result = describeTarget({
        EXOMEM_REHEARSAL_EXPECTED_TARGET: JSON.stringify({ ...target, [key]: "wrong" }),
      });
      assert.notEqual(result.status, 0, key);
      assert.match(result.stderr, /paired runtime target/, key);
    }
    const exact = describeTarget({ EXOMEM_REHEARSAL_EXPECTED_TARGET: JSON.stringify(target) });
    assert.equal(exact.status, 0, exact.stderr);
  });
});
