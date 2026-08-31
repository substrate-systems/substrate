import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const generator = resolve("scripts/generate-exomem-hosted-contract.mjs");
const exactCommit = "76571f2c9f600395344a2a62efe6aca36d32b42d";

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
  it("recognizes only the exact stable 0.68.0 commit/release tuple", () => {
    const exact = generate("0.68.0");
    assert.notEqual(exact.status, 0);
    assert.match(exact.stderr, /checkout is not at the selected commit/i);

    const mixed = generate("0.68.1");
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /only accepts a pinned Exomem release/i);
  });
});
