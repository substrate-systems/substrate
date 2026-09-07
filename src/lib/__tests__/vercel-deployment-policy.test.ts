import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("automatic Vercel deployments are production-only; previews require explicit deployment", () => {
  const config = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"));

  // Vercel uses minimatch rules and enables a branch when any matching rule is
  // true. The globstar also covers slash-containing task branches.
  assert.deepEqual(config.git?.deploymentEnabled, { "**": false, main: true });
});
