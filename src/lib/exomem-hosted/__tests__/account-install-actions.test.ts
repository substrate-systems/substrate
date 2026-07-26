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
    assert.match(queries[0], /artifact\.state = 'live'/i);
    assert.match(
      queries[0],
      /candidate\.profile_id = 'hosted-alpha-agent-v1' AND candidate\.state = 'live'/i
    );
    assert.match(queries[0], /artifact\.contract_sha256 = candidate\.schema_digest/i);
    assert.match(queries[0], /artifact\.compatibility_sha256 = candidate\.compatibility_digest/i);
    assert.match(queries[0], /artifact\.package_sha256 =/i);
    assert.match(queries[0], /artifact\.archive_sha256 =/i);
    assert.match(queries[0], /artifact\.plugin_version =/i);
    assert.match(queries[0], /candidate\.endpoint =/i);
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

  it("hides pending and failed artifacts even when a matching contract query returns them", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          platform: "claude",
          state: "pending",
          plugin_version: "0.34.0",
          install_url: "https://claude.ai/plugins/exomem-hosted",
        },
        {
          platform: "openai",
          state: "failed",
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
      []
    );
  });

  it("returns no action when the required live contract has no matching artifact", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [] };
    });

    assert.deepEqual(
      await loadOwnerInstallActions(
        "018f2d91-7c42-7000-8000-000000000091",
        "018f2d91-7c42-7000-8000-000000000092"
      ),
      []
    );
    assert.match(
      queries[0],
      /JOIN exomem_agent_contract_candidates AS candidate ON candidate\.profile_id = 'hosted-alpha-agent-v1' AND candidate\.state = 'live'/i
    );
  });

  it("requires exact contract, compatibility, package, archive, version, and endpoint identity", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [] };
    });

    assert.deepEqual(
      await loadOwnerInstallActions(
        "018f2d91-7c42-7000-8000-000000000091",
        "018f2d91-7c42-7000-8000-000000000092"
      ),
      []
    );
    assert.match(queries[0], /artifact\.contract_sha256 = candidate\.schema_digest/i);
    assert.match(queries[0], /artifact\.compatibility_sha256 = candidate\.compatibility_digest/i);
    assert.match(queries[0], /artifact\.package_sha256 =/i);
    assert.match(queries[0], /artifact\.archive_sha256 =/i);
    assert.match(queries[0], /artifact\.plugin_version =/i);
    assert.match(queries[0], /candidate\.endpoint =/i);
  });

  it("keeps OpenAI absent until its matching lock exists on the live contract", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [] };
    });

    assert.deepEqual(
      await loadOwnerInstallActions(
        "018f2d91-7c42-7000-8000-000000000091",
        "018f2d91-7c42-7000-8000-000000000092"
      ),
      []
    );
    assert.match(queries[0], /candidate\.openai_package_lock->>'artifact_sha256'/i);
    assert.match(queries[0], /candidate\.openai_archive_lock->>'archive_sha256'/i);
  });
});
