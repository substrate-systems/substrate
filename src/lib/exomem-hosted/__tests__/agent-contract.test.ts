import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import {
  parseExomemAgentContractCandidate,
  promoteExomemAgentContractCandidate,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import { parseClientArtifact, storeClientArtifact } from "../client-artifacts";

afterEach(() => __setExomemSqlForTests(null));

const sha = (character: string) => character.repeat(64);

const compatibility = {
  schema_version: 1,
  endpoint: "https://substratesystems.io/api/exomem/mcp/v1",
  profile: "hosted-alpha-agent-v1",
  source_release: "0.32.0",
  command_surface_sha256: sha("a"),
  schema_contract_sha256: sha("b"),
  compatibility_sha256: sha("c"),
  agent_contract: {
    protocol_version: "1",
    digest: { algorithm: "sha256", value: sha("b") },
    agent_profile: {
      profile: "hosted-alpha-agent-v1",
      active_capability_sha256: sha("a"),
    },
    commands: [
      {
        name: "ask_memory",
        mcp_tool: {
          name: "ask_memory",
          description: "Exact imported description",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      },
    ],
  },
};

const packageLock = {
  platform: "claude",
  plugin_id: "exomem-hosted",
  plugin_version: "0.1.0",
  endpoint: compatibility.endpoint,
  profile: compatibility.profile,
  command_surface_sha256: compatibility.command_surface_sha256,
  schema_contract_sha256: compatibility.schema_contract_sha256,
  compatibility_sha256: compatibility.compatibility_sha256,
  artifact_sha256: sha("d"),
};

const archiveLock = { platform: "claude", archive_sha256: sha("e") };

describe("Exomem Hosted agent contracts", () => {
  it("preserves the imported raw MCP schemas without a local allowlist", () => {
    const candidate = parseExomemAgentContractCandidate({ compatibility, packageLock, archiveLock });

    assert.equal(candidate.state, "pending");
    assert.deepEqual(candidate.tools, compatibility.agent_contract.commands.map((command) => command.mcp_tool));
    assert.equal(candidate.schemaDigest, compatibility.schema_contract_sha256);
  });

  it("rejects a package lock whose profile identity differs from the compatibility artifact", () => {
    assert.throws(
      () => parseExomemAgentContractCandidate({
        compatibility,
        packageLock: { ...packageLock, profile: "wrong-profile" },
        archiveLock,
      }),
      /package lock/i
    );
  });

  it("stores imports as pending and promotes only with an exact routable-cell agreement", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "contract-1" }] };
    });
    const candidate = parseExomemAgentContractCandidate({ compatibility, packageLock, archiveLock });

    await storeExomemAgentContractCandidate(candidate);
    await promoteExomemAgentContractCandidate({
      candidateId: "contract-1",
      expectedRoutableCellDigest: sha("f"),
    });

    assert.match(queries[0], /INSERT INTO exomem_agent_contract_candidates/i);
    assert.match(queries[0], /'pending'/i);
    assert.match(queries[1], /FOR UPDATE/i);
    assert.match(queries[1], /exomem_agent_contract_profile_authority/i);
    assert.match(queries[1], /exomem_routable_cell_contracts/i);
    assert.match(queries[1], /platform = 'claude'/i);
    assert.match(queries[1], /platform = 'openai'/i);
    assert.match(queries[1], /retired_at = now\(\)/i);
    assert.match(queries[1], /UPDATE exomem_agent_contract_candidates/i);
    assert.doesNotMatch(queries[1], /digest\(/i);
  });

  it("stores only tenant-neutral client artifact evidence", async () => {
    const artifact = parseClientArtifact({
      platform: "claude", state: "pending", packageSha256: sha("a"), archiveSha256: sha("b"),
      compatibilitySha256: sha("c"), contractSha256: sha("d"), pluginVersion: "0.1.0",
      clientIdentity: "claude-desktop", installUrl: "https://claude.ai/plugins/exomem-hosted",
      evidenceSha256: sha("e"), resultSha256: sha("f"), observedAt: "2026-07-26T00:00:00.000Z",
    });
    let query = "";
    __setExomemSqlForTests(async (strings) => {
      query = strings.join("?");
      return { rows: [{ id: "artifact-1" }] };
    });
    assert.equal(await storeClientArtifact(artifact), "artifact-1");
    assert.match(query, /INSERT INTO exomem_client_artifacts/i);
    assert.throws(
      () => parseClientArtifact({ ...artifact, installUrl: "https://claude.ai/plugins/exomem-hosted?tenant=private" }),
      /tenant-neutral/i
    );
    assert.throws(
      () => parseClientArtifact({ ...artifact, installUrl: "https://user:pass@claude.ai/plugins/exomem-hosted" }),
      /tenant-neutral/i
    );
  });
});
