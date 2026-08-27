import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXOMEM_HOSTED_PROFILE } from "../hosted-profile";

const currentFlowModules = [
  "agent-contract-canaries.ts",
  "db.ts",
  "fleet-observation.ts",
  "hosted-cohort-target.ts",
  "lifecycle-store.ts",
  "mcp.ts",
  "oauth-store.ts",
  "operator-controls.ts",
  "paddle-event-store.ts",
  "promotion-runtime.ts",
  "reviewer-access-store.ts",
] as const;

test("the private-alpha current flow has one v4 profile authority", async () => {
  assert.equal(EXOMEM_HOSTED_PROFILE, "hosted-alpha-agent-v4");
  for (const moduleName of currentFlowModules) {
    const source = await readFile(
      fileURLToPath(new URL(`../${moduleName}`, import.meta.url)),
      "utf8"
    );
    assert.doesNotMatch(
      source,
      /["']hosted-alpha-agent-v1["']/,
      `${moduleName} still pins the historical v1 profile in the current flow`
    );
  }
});
