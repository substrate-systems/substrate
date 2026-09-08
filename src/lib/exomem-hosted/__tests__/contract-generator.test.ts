import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  const directProducerRepo = process.env.EXOMEM_TEST_PRODUCER_REPO;
  it(
    "generates the approved direct fixture bytes from its pinned producer",
    {
      skip: directProducerRepo
        ? false
        : "set EXOMEM_TEST_PRODUCER_REPO to the pinned Exomem producer checkout",
    },
    () => {
      const output = mkdtempSync(join(tmpdir(), "exomem-hosted-direct-generator-"));
      try {
        const direct = spawnSync(
          process.execPath,
          [
            generator,
            "--exomem-repo",
            directProducerRepo!,
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
        assert.equal(
          readFileSync(join(output, "fixture.ts"), "utf8"),
          readFileSync(resolve("src/lib/exomem-hosted/agent-contract-fixture-direct-v1.ts"), "utf8")
        );
        assert.equal(
          readFileSync(join(output, "fixture.json"), "utf8"),
          readFileSync(
            resolve("src/lib/exomem-hosted/__tests__/agent-contract-fixture-direct-v1.json"),
            "utf8"
          )
        );
      } finally {
        rmSync(output, { recursive: true, force: true });
      }
    }
  );
});
