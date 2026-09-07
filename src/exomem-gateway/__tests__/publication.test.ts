import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { verifyGatewayPublication } from "../../../scripts/verify-exomem-gateway-publication.mjs";

const workflowPath = path.join(process.cwd(), ".github/workflows/publish-exomem-gateway.yml");
const runbookPath = path.join(process.cwd(), "docs/runbooks/exomem-gateway-publication.md");

function workflow(): string {
  return readFileSync(workflowPath, "utf8");
}

function runbook(): string {
  return readFileSync(runbookPath, "utf8");
}

describe("hosted gateway publication policy", () => {
  test("keeps publishing manually dispatched, main-only, and source-bound", () => {
    assert.doesNotThrow(() => verifyGatewayPublication(workflow()));
  });

  test("rejects an automatic trigger or a non-canonical registry", () => {
    assert.throws(
      () =>
        verifyGatewayPublication(
          workflow()
            .replace("  workflow_dispatch:\n", "  push:\n    branches: [main]\n")
            .replaceAll(
              "ghcr.io/substrate-systems/substrate-gateway",
              "ghcr.io/artexis10/substrate-gateway"
            )
        ),
      /workflow_dispatch|canonical GHCR image/
    );
  });

  test("rejects another trigger and a commented source gate", () => {
    assert.throws(
      () =>
        verifyGatewayPublication(
          workflow()
            .replace(
              "  workflow_dispatch:\n",
              "  workflow_dispatch:\n  workflow_run:\n    workflows: [test]\n    types: [completed]\n"
            )
            .replace(
              'test "$GITHUB_EVENT_NAME" = "workflow_dispatch"',
              '# test "$GITHUB_EVENT_NAME" = "workflow_dispatch"'
            )
        ),
      /only trigger|manual dispatch gate/
    );
  });

  test("requires an explicit public-package decision and anonymous pull check", () => {
    assert.match(runbook(), /must already be public/);
    assert.match(runbook(), /anonymous manifest readback/);
  });

  test("rejects publishing without an anonymous exact-digest pull proof", () => {
    assert.throws(
      () =>
        verifyGatewayPublication(
          workflow().replace(
            "      - name: Verify anonymous gateway manifest pull",
            "      - name: Skip anonymous gateway manifest pull"
          )
        ),
      /anonymous exact-digest manifest pull proof/
    );
  });

  test("rejects an anonymous manifest readback that accepts HTTP failures", () => {
    const manifestCurl = [
      "          curl --fail --silent --show-error \\",
      '            --header "Authorization: Bearer $' + "{pull_token}" + '"',
    ].join("\n");
    const nonFailingManifestCurl = [
      "          curl --silent --show-error \\",
      '            --header "Authorization: Bearer $' + "{pull_token}" + '"',
    ].join("\n");

    assert.throws(
      () => verifyGatewayPublication(workflow().replace(manifestCurl, nonFailingManifestCurl)),
      /manifest curl failure semantics/
    );
  });

  test("exposes the same guard as a CI-friendly script", () => {
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, ["scripts/verify-exomem-gateway-publication.mjs"], {
        cwd: process.cwd(),
        stdio: "pipe",
      })
    );
  });
});
