import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { assertRuntimeTrustImport, buildHostedRuntimeTrustReport } from "../runtime-trust-report";

// Deliberately restated rather than imported: REVIEWED_TARGET is unexported, and a
// test that borrowed it could not detect the pin drifting. These values are the
// ten-field output of Exomem's `hosted_image_candidate.py verify` for v0.66.0.
const target = {
  releaseVersion: "0.66.0",
  sourceCommit: "efd6e15f40221bb3821f979d6fcbda45e7c6a649",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:707d06b3ee4ee8cf12ae5a9cae9514fc7e1b5fa0cda82b6a15998bdfc97c59e8",
  runtimeCandidateSha256: "ef7424809847ed7aa6909b9d85fb4b5e437d1cefa45ab813d595fc31ce1a184c",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v4",
  gatewayContractDigest: "b520dbf5509519b7822d0abd628514d1c1a2ee45f2c68958cf8b5e218444accb",
  commandFingerprint: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
  schemaDigest: "55f704688e015a4497f9ca8da49169a717c282aacec838bfde52c08c12cdf95c",
  compatibilityDigest: "4a12a115086166c5b37cde02e6bfcc6aa2c095b6d073dc23f5634803b13c0ce9",
};
const consumerCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

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
});
