import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { assertRuntimeTrustImport, buildHostedRuntimeTrustReport } from "../runtime-trust-report";

const target = {
  releaseVersion: "0.57.2",
  sourceCommit: "d4bbef7725d55f3bb6e8c288deadddb15ef7855f",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:d706cd09d153f8316d3834b000b567f2925380474a5071cbae4d0accd8781fa9",
  runtimeCandidateSha256: "c0ece957e5bee3a28ac007df89c84cab3d28b674358921bd0bd921e295ab08b9",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v1",
  gatewayContractDigest: "33c461c0d38c70acd415020363bfdce589041fa038702d8c9021663009e33ec3",
  commandFingerprint: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
  schemaDigest: "30c65de187984940a57a122638d42a85989b7409e1eccb026a828fd1d785d788",
  compatibilityDigest: "9e028c9e2001378a4ab5fc6f2c3a421e5502cf9e59fb043d6066055f115c08ea",
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
