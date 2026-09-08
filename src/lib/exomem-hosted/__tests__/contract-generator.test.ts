import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const generator = resolve("scripts/generate-exomem-hosted-contract.mjs");
const exactCommit = "bd95fc9826069ec66f142c821abfda4b2f1d0912";
const directCommit = "e74ca4eb89763b6104787456a2636e6469054b1a";

function generate(sourceRelease: string) {
  const output = mkdtempSync(join(tmpdir(), "exomem-hosted-generator-"));
  return spawnSync(
    process.execPath,
    [
      generator,
      "--exomem-repo",
      process.cwd(),
      "--output",
      join(output, "fixture.ts"),
      "--json-output",
      join(output, "fixture.json"),
      "--expected-commit",
      exactCommit,
      "--source-release",
      sourceRelease,
    ],
    { encoding: "utf8" }
  );
}

describe("Exomem Hosted contract generator catalog", () => {
  it("recognizes only the exact stable 0.74.0 command-binding commit/release tuple", () => {
    const exact = generate("0.74.0");
    assert.notEqual(exact.status, 0);
    assert.match(exact.stderr, /checkout is not at the selected commit/i);

    const mixed = generate("0.73.1");
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /only accepts a pinned Exomem release/i);
  });

  it("generates only the approved direct candidate with its pinned endpoint", () => {
    const output = mkdtempSync(join(tmpdir(), "exomem-hosted-direct-generator-"));
    const direct = spawnSync(
      process.execPath,
      [
        generator,
        "--exomem-repo",
        "/home/hugoa/projects/exomem-hosted-direct-artifacts",
        "--output",
        join(output, "fixture.ts"),
        "--json-output",
        join(output, "fixture.json"),
        "--expected-commit",
        directCommit,
        "--source-release",
        "0.75.0",
      ],
      { encoding: "utf8" }
    );
    assert.equal(direct.status, 0, direct.stderr);
  });
});
