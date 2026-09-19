import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assertRuntimeTrustFixtureProjection,
  assertRuntimeTrustImport,
  assertRuntimeTrustSitePin,
  buildHostedRuntimeTrustReport,
} from "../runtime-trust-report";

// Deliberately restated rather than imported: REVIEWED_TARGET is unexported, and a
// test that borrowed it could not detect the pin drifting. These values are the
// ten-field output of Exomem's `hosted_image_candidate.py verify` for v0.89.0.
const target = {
  agentProfile: "hosted-alpha-agent-v4",
  commandFingerprint: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
  compatibilityDigest: "320e75168c5f72b73551e56f43a82b8d3ee77bf39158ae42ef3292a25b576ec6",
  gatewayContractDigest: "dd24d80b33c21d849467a30e1c38ebf94d5e0c7f3b96cb540eccbed17f441692",
  protocolVersion: "1",
  releaseVersion: "0.89.0",
  runtimeCandidateSha256: "ba2469d49b26260dad02ef7d9c50a72eac6ed7810468b535316144e51458c57f",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:7d1039ab2e07cefe56cf2dd2e247f233d19205a7a2c7cfcb94336c438cd05d4b",
  schemaDigest: "60b5aec6f872874234a214e778e26ce57fa5805af8ce744bdd68efe8ca0fcb26",
  sourceCommit: "cefa987cce5dfc5efe70dc1a51ab37037afb6ea8",
};
const consumerCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function source(path: string): string {
  return readFileSync(`src/lib/exomem-hosted/${path}`, "utf8");
}

function mutate(original: string, exact: string, replacement = ""): string {
  const changed = original.replace(exact, replacement);
  assert.notEqual(changed, original, `mutation did not match: ${exact}`);
  return changed;
}

describe("hosted runtime trust report", () => {
  it("proves the exact target at every release-pinned consumer site", async () => {
    const report = await buildHostedRuntimeTrustReport({
      repository: process.cwd(),
      consumerCommit,
      target,
    });

    assert.equal(report.target, target);
    assert.deepEqual(report.pinnedSites, [
      "agent-canaries",
      "agent-contract-store",
      "client-artifacts",
      "gateway-store",
      "lifecycle-store",
      "reviewer-operator",
    ]);
    assert.match(report.fixtureSha256s.agent, /^[a-f0-9]{64}$/);
    assert.match(report.fixtureSha256s.gateway, /^[a-f0-9]{64}$/);
  });

  it("reads every trust input from the named repository commit", async () => {
    await assert.rejects(
      buildHostedRuntimeTrustReport({
        repository: process.cwd(),
        consumerCommit: "a".repeat(40),
        target,
      }),
      /consumer commit or pinned file is unavailable/
    );
  });

  it("rejects a target that differs from the reviewed release pin", async () => {
    await assert.rejects(
      buildHostedRuntimeTrustReport({
        repository: process.cwd(),
        consumerCommit: "a".repeat(40),
        target: { ...target, schemaDigest: "0".repeat(64) },
      }),
      /runtime target differs from the reviewed release pin/
    );
  });

  for (const field of ["runtimeImage", "runtimeCandidateSha256"] as const) {
    it(`rejects a target whose ${field} differs from the reviewed release pin`, async () => {
      await assert.rejects(
        buildHostedRuntimeTrustReport({
          repository: process.cwd(),
          consumerCommit: "a".repeat(40),
          target: {
            ...target,
            [field]:
              field === "runtimeImage"
                ? `ghcr.io/artexis10/exomem@sha256:${"0".repeat(64)}`
                : "0".repeat(64),
          },
        }),
        /runtime target differs from the reviewed release pin/
      );
    });
  }

  it("rejects comments and unused imports as runtime trust evidence", () => {
    assert.throws(
      () =>
        assertRuntimeTrustImport(
          "// import { exact } from './target';\nconst active = true;\n",
          "comment-only",
          { module: "./target", symbol: "exact" }
        ),
      /does not import/
    );
    assert.throws(
      () =>
        assertRuntimeTrustImport(
          "import { exact } from './target';\nconst active = true;\n",
          "unused-import",
          { module: "./target", symbol: "exact" }
        ),
      /does not use/
    );
    assert.doesNotThrow(() =>
      assertRuntimeTrustImport(
        "import { exact as selected } from './target';\nexport const live = selected;\n",
        "live-import",
        { module: "./target", symbol: "exact" }
      )
    );
  });

  it("rejects shadowed and type-only names as runtime trust evidence", () => {
    assert.throws(
      () =>
        assertRuntimeTrustImport(
          "import { exact } from './target';\nfunction fake(exact: string) { return exact; }\n",
          "shadowed-import",
          { module: "./target", symbol: "exact" }
        ),
      /does not use/
    );
    assert.throws(
      () =>
        assertRuntimeTrustImport(
          "import { exact } from './target';\nexport type Selected = typeof exact;\n",
          "type-only-import",
          { module: "./target", symbol: "exact" }
        ),
      /does not use/
    );
  });

  it("couples the generated TypeScript fixtures to the reviewed JSON projections", () => {
    const agentJson = JSON.parse(source("__tests__/agent-contract-fixture.json"));
    const gatewayJson = JSON.parse(source("__tests__/gateway-contract-0-89-0.json"));
    const agentTypeScript = source("agent-contract-fixture.ts");
    const gatewayTypeScript = source("gateway-contract-0-89-0.ts");

    assert.doesNotThrow(() =>
      assertRuntimeTrustFixtureProjection({
        agentTypeScript,
        agentJson,
        gatewayTypeScript,
        gatewayJson,
        target,
      })
    );
    assert.throws(
      () =>
        assertRuntimeTrustFixtureProjection({
          agentTypeScript: mutate(
            agentTypeScript,
            '"sourceRelease": "0.89.0"',
            '"sourceRelease": "0.68.0"'
          ),
          agentJson,
          gatewayTypeScript,
          gatewayJson,
          target,
        }),
      /TypeScript agent fixture differs/
    );
    assert.throws(
      () =>
        assertRuntimeTrustFixtureProjection({
          agentTypeScript,
          agentJson,
          gatewayTypeScript: mutate(
            gatewayTypeScript,
            target.gatewayContractDigest,
            "0".repeat(64)
          ),
          gatewayJson,
          target,
        }),
      /TypeScript gateway fixture differs/
    );
  });

  const siteMutations = [
    {
      name: "agent-canaries",
      path: "agent-contract-canaries.ts",
      exact:
        'WHEN ${exomemContractFixture0890.release + ":" + exomemContractFixture0890.protocol}\n                   THEN ${gatewayContractDigests.get(exomemContractFixture0890.release + ":" + exomemContractFixture0890.protocol)}',
      decoy:
        '\nconst runtimeTrustDecoy = sql`WHEN ${exomemContractFixture0740.release + ":" + exomemContractFixture0740.protocol} THEN ${gatewayContractDigests.get(exomemContractFixture0740.release + ":" + exomemContractFixture0740.protocol)}`;\n',
    },
    {
      name: "agent-contract-store",
      path: "agent-contract-store.ts",
      exact: "checkedExomemAgentContractCandidate(exomemHostedContractFixture)",
      replacement: "checkedExomemAgentContractCandidate(exomemHostedContractFixture0680)",
      decoy:
        "\nfunction runtimeTrustDecoy() { return checkedExomemAgentContractCandidate(exomemHostedContractFixture); }\n",
    },
    {
      name: "client-artifacts",
      path: "client-artifacts.ts",
      exact: 'row.source_release === "0.89.0"',
      replacement: 'row.source_release === "9.9.9"',
      decoy:
        '\nconst runtimeTrustDecoy = row.source_release === "0.74.0" ? exomemHostedContractFixture0740 : null;\n',
    },
    {
      name: "gateway-store",
      path: "gateway.ts",
      exact: "Object.freeze({ full: exomemContractFixture0890, agent: agentFixture0890 }),",
      decoy:
        "\nconst runtimeTrustDecoy = { full: exomemContractFixture0740, agent: agentFixture0740 };\n",
    },
    {
      name: "lifecycle-store",
      path: "lifecycle-store.ts",
      exact: "runtime_target.schema_digest = candidate.schema_digest",
      decoy:
        '\nconst runtimeTrustDecoy = sql`WHEN ${exomemContractFixture0740.release + ":" + exomemContractFixture0740.protocol} THEN ${exomemContractFixture0740.digest}`;\n',
    },
    {
      name: "reviewer-operator",
      path: "operator-controls.ts",
      exact: "candidate.source_release = ${exomemContractFixture0890.release}",
      replacement: "candidate.source_release = '0.68.0'",
      decoy:
        "\nconst runtimeTrustDecoy = sql`candidate.source_release = ${exomemContractFixture0740.release} AND candidate.protocol_version = ${exomemContractFixture0740.protocol} THEN ${exomemContractFixture0740.digest}`;\n",
    },
  ] as const;

  for (const site of siteMutations) {
    it(`rejects a missing exact 0.89.0 branch at ${site.name}`, () => {
      const original = source(site.path);
      assert.doesNotThrow(() => assertRuntimeTrustSitePin(original, site.name, target));
      assert.throws(
        () =>
          assertRuntimeTrustSitePin(
            `${mutate(original, site.exact, "replacement" in site ? site.replacement : "")}\n${site.decoy}`,
            site.name,
            target
          ),
        /does not pin the exact runtime target/
      );
    });
  }
});
