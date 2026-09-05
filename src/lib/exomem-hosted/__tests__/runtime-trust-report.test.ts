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
// ten-field output of Exomem's `hosted_image_candidate.py verify` for v0.72.1.
const target = {
  releaseVersion: "0.72.1",
  sourceCommit: "9720ccdfcc3e5e77ea47c56ddbddc53d75de40aa",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:aa61a1cd1f70308c1b702384ebc98e1bb5e3e70b511ef9403446ed47f7a5148c",
  runtimeCandidateSha256: "642c8efa4539d1bcc370e60d6f1f461a216301417b34df0816a0481d223a8e47",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v4",
  gatewayContractDigest: "a04bfa469343ec5ef5386d1921b9b3516ddf9a3c62c8b540e7d8110afa96a1b7",
  commandFingerprint: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
  schemaDigest: "60b5aec6f872874234a214e778e26ce57fa5805af8ce744bdd68efe8ca0fcb26",
  compatibilityDigest: "636d271faaa57d38730a5638abb9f12797cb49189e99be9762632f03ae49117c",
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
    const gatewayJson = JSON.parse(source("__tests__/gateway-contract-0-72-1.json"));
    const agentTypeScript = source("agent-contract-fixture.ts");
    const gatewayTypeScript = source("gateway-contract-0-72-1.ts");

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
            '"sourceRelease": "0.72.1"',
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
        'WHEN ${exomemContractFixture0721.release + ":" + exomemContractFixture0721.protocol}\n                   THEN ${gatewayContractDigests.get(exomemContractFixture0721.release + ":" + exomemContractFixture0721.protocol)}',
      decoy:
        '\nconst runtimeTrustDecoy = sql`WHEN ${exomemContractFixture0721.release + ":" + exomemContractFixture0721.protocol} THEN ${gatewayContractDigests.get(exomemContractFixture0721.release + ":" + exomemContractFixture0721.protocol)}`;\n',
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
      exact: 'row.source_release === "0.72.1"',
      replacement: 'row.source_release === "9.9.9"',
      decoy:
        '\nconst runtimeTrustDecoy = row.source_release === "0.72.1" ? exomemHostedContractFixture0721 : null;\n',
    },
    {
      name: "gateway-store",
      path: "gateway.ts",
      exact: "Object.freeze({ full: exomemContractFixture0721, agent: agentFixture0721 }),",
      decoy:
        "\nconst runtimeTrustDecoy = { full: exomemContractFixture0721, agent: agentFixture0721 };\n",
    },
    {
      name: "lifecycle-store",
      path: "lifecycle-store.ts",
      exact:
        'WHEN ${exomemContractFixture0721.release + ":" + exomemContractFixture0721.protocol}\n                     THEN ${exomemContractFixture0721.digest}',
      decoy:
        '\nconst runtimeTrustDecoy = sql`WHEN ${exomemContractFixture0721.release + ":" + exomemContractFixture0721.protocol} THEN ${exomemContractFixture0721.digest}`;\n',
    },
    {
      name: "reviewer-operator",
      path: "operator-controls.ts",
      exact: "candidate.source_release = ${exomemContractFixture0721.release}",
      replacement: "candidate.source_release = '0.68.0'",
      decoy:
        "\nconst runtimeTrustDecoy = sql`candidate.source_release = ${exomemContractFixture0721.release} AND candidate.protocol_version = ${exomemContractFixture0721.protocol} THEN ${exomemContractFixture0721.digest}`;\n",
    },
  ] as const;

  for (const site of siteMutations) {
    it(`rejects a missing exact 0.72.1 branch at ${site.name}`, () => {
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
