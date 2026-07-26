import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import { loadOwnerInstallActions } from "../account-install-actions";

afterEach(() => __setExomemSqlForTests(null));

describe("owner install actions", () => {
  it("returns only the public fields from live artifacts for an eligible owner", async () => {
    const userId = "018f2d91-7c42-7000-8000-000000000091";
    const tenantId = "018f2d91-7c42-7000-8000-000000000092";
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return {
        rows: [
          {
            platform: "claude",
            state: "live",
            plugin_version: "0.34.0",
            install_url: "https://claude.ai/plugins/exomem-hosted",
            tenant_id: tenantId,
            evidence_sha256: "a".repeat(64),
          },
        ],
      };
    });

    assert.deepEqual(await loadOwnerInstallActions(userId, tenantId), [
      {
        platform: "claude",
        version: "0.34.0",
        installUrl: "https://claude.ai/plugins/exomem-hosted",
      },
    ]);
    assert.match(queries[0], /state = 'live'/i);
    assert.match(queries[0], /tenant\.owner_user_id = \?/i);
    assert.match(queries[0], /tenant\.id = \?/i);
    assert.match(
      queries[0],
      /entitlement\.effective_state IN \('provisioning', 'active', 'grace'\)/i
    );
    assert.doesNotMatch(queries[0], /mcp|token|bearer|secret/i);
  });

  it("hides malformed or tenant-specific URLs even when a row is marked live", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          platform: "claude",
          state: "pending",
          plugin_version: "0.34.0",
          install_url: "https://claude.ai/plugins/exomem-hosted?tenant=private",
        },
        {
          platform: "openai",
          state: "live",
          plugin_version: "0.34.0",
          install_url: "https://chatgpt.com/plugins/exomem-hosted",
        },
      ],
    }));

    assert.deepEqual(
      await loadOwnerInstallActions(
        "018f2d91-7c42-7000-8000-000000000091",
        "018f2d91-7c42-7000-8000-000000000092"
      ),
      [
        {
          platform: "openai",
          version: "0.34.0",
          installUrl: "https://chatgpt.com/plugins/exomem-hosted",
        },
      ]
    );
  });
});
