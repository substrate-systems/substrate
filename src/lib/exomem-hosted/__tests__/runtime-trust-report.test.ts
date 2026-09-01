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
// ten-field output of Exomem's `hosted_image_candidate.py verify` for v0.68.1.
const target = {
  releaseVersion: "0.68.1",
  sourceCommit: "e487efa2fdfd8c7653b6e99605163a0200c6ce58",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:9870b3f661969a70504fb4ccad60b6429c21c13732f754d0e8aef030e3277246",
  runtimeCandidateSha256: "6743cf711b08cf8b64a7db8a62ce06f4a9246e59cc54a76f23c102959fc10aa9",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v4",
  gatewayContractDigest: "2af163baf368643f41d7fa4eaa0c3d2d0f2ead54443fd0263d2977dc4094a469",
  commandFingerprint: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
  schemaDigest: "124fb718c6d2b6caee93edd7281fbc6cd7ca991e4a39bcc90df00bf0811208fd",
  compatibilityDigest: "62356a1220b823e9ae91e1fab18a8da5711481b6cc907dbcae033e254a3585dc",
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
    const gatewayJson = JSON.parse(source("__tests__/gateway-contract-0-68-1.json"));
    const agentTypeScript = source("agent-contract-fixture.ts");
    const gatewayTypeScript = source("gateway-contract-0-68-1.ts");

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
            '"sourceRelease": "0.68.1"',
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
        'WHEN ${exomemContractFixture0681.release + ":" + exomemContractFixture0681.protocol}\n                   THEN ${gatewayContractDigests.get(exomemContractFixture0681.release + ":" + exomemContractFixture0681.protocol)}',
      decoy:
        '\nconst runtimeTrustDecoy = sql`WHEN ${exomemContractFixture0681.release + ":" + exomemContractFixture0681.protocol} THEN ${gatewayContractDigests.get(exomemContractFixture0681.release + ":" + exomemContractFixture0681.protocol)}`;\n',
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
      exact: 'row.source_release === "0.68.1"',
      replacement: 'row.source_release === "9.9.9"',
      decoy:
        '\nconst runtimeTrustDecoy = row.source_release === "0.68.1" ? exomemHostedContractFixture0681 : null;\n',
    },
    {
      name: "gateway-store",
      path: "gateway.ts",
      exact: "Object.freeze({ full: exomemContractFixture0681, agent: agentFixture0681 }),",
      decoy:
        "\nconst runtimeTrustDecoy = { full: exomemContractFixture0681, agent: agentFixture0681 };\n",
    },
    {
      name: "lifecycle-store",
      path: "lifecycle-store.ts",
      exact:
        'WHEN ${exomemContractFixture0681.release + ":" + exomemContractFixture0681.protocol}\n                     THEN ${exomemContractFixture0681.digest}',
      decoy:
        '\nconst runtimeTrustDecoy = sql`WHEN ${exomemContractFixture0681.release + ":" + exomemContractFixture0681.protocol} THEN ${exomemContractFixture0681.digest}`;\n',
    },
    {
      name: "reviewer-operator",
      path: "operator-controls.ts",
      exact: "candidate.source_release = ${exomemContractFixture0681.release}",
      replacement: "candidate.source_release = '0.68.0'",
      decoy:
        "\nconst runtimeTrustDecoy = sql`candidate.source_release = ${exomemContractFixture0681.release} AND candidate.protocol_version = ${exomemContractFixture0681.protocol} THEN ${exomemContractFixture0681.digest}`;\n",
    },
  ] as const;

  for (const site of siteMutations) {
    it(`rejects a missing exact 0.68.1 branch at ${site.name}`, () => {
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
