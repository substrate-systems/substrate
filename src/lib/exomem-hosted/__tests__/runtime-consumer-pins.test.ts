import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  buildHostedRuntimeConsumerPinReport,
  buildHostedRuntimeTrustReport,
} from "../runtime-trust-report";

it("consumer pins can precede the manifest while full trust still requires the exact committed manifest", async () => {
  const base = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const agent = JSON.parse(
    execFileSync(
      "git",
      ["show", `${base}:src/lib/exomem-hosted/__tests__/agent-contract-fixture.json`],
      { encoding: "utf8" }
    )
  );
  const path = `src/lib/exomem-hosted/runtime-target-${agent.sourceRelease.replaceAll(".", "-")}.json`;
  const manifest = JSON.parse(
    execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8" })
  );
  const repository = mkdtempSync(join(tmpdir(), "runtime-pin-report-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    execFileSync("git", ["clone", "--shared", "--no-checkout", process.cwd(), repository], {
      stdio: "pipe",
    });
    git("checkout", "--detach", base);
    git("rm", path);
    const commit = () => {
      git(
        "-c",
        "user.name=Runtime trust test",
        "-c",
        "user.email=runtime-test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "test fixture"
      );
      return git("rev-parse", "HEAD");
    };
    const input = { repository, consumerCommit: commit(), target: manifest.target };
    const pins = await buildHostedRuntimeConsumerPinReport(input);
    assert.equal(pins.artifact, "exomem-hosted-substrate-runtime-consumer-pins");
    assert.equal(pins.pinnedSites.length, 6);
    await assert.rejects(
      buildHostedRuntimeTrustReport(input),
      /consumer commit or pinned file is unavailable/
    );
    writeFileSync(
      join(repository, path),
      JSON.stringify({
        ...manifest,
        target: { ...manifest.target, runtimeCandidateSha256: "0".repeat(64) },
      })
    );
    git("add", path);
    input.consumerCommit = commit();
    await assert.rejects(buildHostedRuntimeTrustReport(input), /imported runtime manifest differs/);
    writeFileSync(join(repository, path), JSON.stringify(manifest));
    git("add", path);
    input.consumerCommit = commit();
    const full = await buildHostedRuntimeTrustReport(input);
    assert.equal(full.artifact, "exomem-hosted-substrate-runtime-trust");
    assert.notEqual(pins.artifact, full.artifact);
    writeFileSync(join(repository, "src/lib/exomem-hosted/operator-controls.ts"), "export {};\n");
    git("add", "src/lib/exomem-hosted/operator-controls.ts");
    input.consumerCommit = commit();
    await assert.rejects(
      buildHostedRuntimeConsumerPinReport(input),
      /does not import the exact runtime target/
    );
    await assert.rejects(
      buildHostedRuntimeTrustReport(input),
      /does not import the exact runtime target/
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
