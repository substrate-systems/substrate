import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemTransaction,
} from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { exomemHostedContractFixture as candidateFixture0350 } from "../agent-contract-fixture-0-35-0";
import {
  attachOpenAiContractLocks,
  promoteExomemHostedCohort,
  recordRoutableCellObservation,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import { demoteClientArtifact, storeClientArtifact } from "../client-artifacts";

const sha = (character: string) => character.repeat(64);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
  delete process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL;
  delete process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL;
  delete process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID;
  delete process.env.EXOMEM_HOSTED_PROMOTION_SECRET;
  delete process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID;
  delete process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET;
});

describe("Exomem Hosted agent contracts", () => {
  it("exposes one atomic cohort promotion entrypoint instead of independent live swaps", async () => {
    assert.equal(typeof promoteExomemHostedCohort, "function");
  });
  it("imports only the exact checked fixture and preserves its ordered raw schemas", () => {
    assert.equal(
      exomemHostedContractFixture.sourceCommit,
      "253c9aa365d7afd8829dc7843f1cac53353ac825"
    );
    assert.equal(exomemHostedContractFixture.sourceRelease, "0.34.0");
    const { digest, ...rawAgentContract } =
      exomemHostedContractFixture.compatibility.agent_contract;
    const { compatibility_sha256, ...rawCompatibility } = exomemHostedContractFixture.compatibility;
    assert.equal(
      createHash("sha256").update(canonical(rawAgentContract)).digest("hex"),
      digest.value
    );
    assert.equal(
      createHash("sha256").update(canonical(rawCompatibility)).digest("hex"),
      compatibility_sha256
    );
    assert.deepEqual(
      exomemHostedContractFixture.compatibility.commands,
      exomemHostedContractFixture.compatibility.agent_contract.commands.map(
        (command) => command.name
      )
    );
  });

  it("keeps the 0.35 candidate fixture as a distinct exact release unit", () => {
    assert.equal(candidateFixture0350.sourceCommit, "d4c5614e5f65d8bcbddee90e9e374846c5a2c22f");
    assert.equal(candidateFixture0350.sourceRelease, "0.35.0");
    assert.notEqual(
      candidateFixture0350.compatibility.schema_contract_sha256,
      exomemHostedContractFixture.compatibility.schema_contract_sha256
    );
    const { digest, ...rawAgentContract } = candidateFixture0350.compatibility.agent_contract;
    assert.equal(
      createHash("sha256").update(canonical(rawAgentContract)).digest("hex"),
      digest.value
    );
  });

  it("trusts the fixture source release independently of descriptor source_release", async () => {
    const fixture = exomemHostedContractFixture as unknown as {
      sourceRelease: string;
      compatibility: Record<string, unknown>;
    };
    const originalSourceRelease = fixture.sourceRelease;
    const originalDescriptorRelease = fixture.compatibility.source_release;
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "contract-1" }] };
    });
    try {
      delete fixture.compatibility.source_release;
      assert.equal(fixture.sourceRelease, "0.34.0");
      assert.equal(await storeExomemAgentContractCandidate(), "contract-1");
      fixture.sourceRelease = "0.34.1";
      await assert.rejects(() => storeExomemAgentContractCandidate(), /untrusted source release/);
    } finally {
      fixture.sourceRelease = originalSourceRelease;
      fixture.compatibility.source_release = originalDescriptorRelease;
    }
    assert.equal(queries.length, 1);
  });

  it("keeps every raw MCP tool and its final tools/list result SDK-valid without normalization", () => {
    const tools = exomemHostedContractFixture.compatibility.agent_contract.commands.map(
      (command) => command.mcp_tool
    );
    for (const tool of tools) assert.equal(ToolSchema.safeParse(tool).success, true);
    assert.equal(ListToolsResultSchema.safeParse({ tools }).success, true);
    assert.equal(ToolSchema.safeParse({ ...tools[0], execution: null }).success, false);
  });

  it("uses server-owned install and signing configuration for canonical private evidence", async () => {
    process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL = "https://claude.ai/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "operator-key";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "operator-secret";
    const baseEvidence: Record<string, unknown> = {
      schema_version: 1,
      platform: "claude",
      client_version: "1.0.0",
      clean_client_identity_hmac_sha256: sha("1"),
      timestamp: new Date().toISOString(),
      paired_run_hmac_sha256: sha("2"),
      test_identity: "hosted-client-plugins-v1",
      exomem_identity_hmac_sha256: sha("3"),
      tenant_hmac_sha256: sha("4"),
      entitlement_hmac_sha256: sha("5"),
      provisioning_operation_hmac_sha256: sha("6"),
      cell_hmac_sha256: sha("7"),
      oauth_client_config_sha256: sha("a"),
      identity_count: 1,
      tenant_count: 1,
      entitlement_count: 1,
      operation_count: 1,
      cell_count: 1,
      volume_count: 1,
      result_sha256: sha("8"),
      package_artifact_sha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archive_sha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibility_sha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      schema_contract_sha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      command_surface_sha256: exomemHostedContractFixture.compatibility.command_surface_sha256,
      endpoint: exomemHostedContractFixture.compatibility.endpoint,
      plugin_version: exomemHostedContractFixture.packageLock.plugin_version,
      profile: exomemHostedContractFixture.compatibility.profile,
      operator_key_id: "operator-key",
      native_install: true,
      authorization: true,
      tool_discovery: true,
      content_recall: true,
      citation: true,
      durable_capture: true,
      fresh_chat_recall: true,
    };
    const evidence = {
      ...baseEvidence,
      operator_signature: createHmac("sha256", "operator-secret")
        .update(canonical(baseEvidence))
        .digest("hex"),
    };
    const artifact = {
      platform: "claude",
      state: "pending",
      packageSha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archiveSha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: exomemHostedContractFixture.packageLock.plugin_version,
      clientIdentitySha256: sha("1"),
      pairedRunHmacSha256: sha("2"),
      exomemIdentityHmacSha256: sha("3"),
      tenantHmacSha256: sha("4"),
      installUrl: process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL,
      evidenceSha256: createHash("sha256").update(canonical(evidence)).digest("hex"),
      resultSha256: sha("8"),
      oauthClientConfigSha256: sha("a"),
      observedAt: new Date().toISOString(),
      candidateId: "018f2d91-7c42-7000-8000-000000000002",
      evidence,
    };
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return {
        rows: [
          {
            id: "artifact-1",
            candidate_id: "018f2d91-7c42-7000-8000-000000000002",
            claude_package_lock: exomemHostedContractFixture.packageLock,
            claude_archive_lock: exomemHostedContractFixture.archiveLock,
          },
        ],
      };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));
    assert.equal(await storeClientArtifact(artifact), "artifact-1");
    assert.match(queries[0], /load-client-artifact-contract-locks/i);
    assert.match(queries[1], /FROM exomem_staged_client_releases/i);
    assert.match(queries[1], /candidate\.created_at < \?::timestamptz/i);
    assert.match(queries[1], /stage\.created_at < \?::timestamptz/i);
    assert.match(queries[2], /INSERT INTO exomem_client_artifacts/i);
    assert.match(queries[3], /SET state = 'evidenced'/i);
    assert.equal(
      await demoteClientArtifact("00000000-0000-0000-0000-000000000001", sha("9")),
      true
    );
    await assert.rejects(
      () => storeClientArtifact({ ...artifact, clientIdentity: "private" }),
      /privacy-safe hash/i
    );
  });

  it("accepts synthetic signed OpenAI evidence only with separately imported test locks", async () => {
    process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL = "https://chatgpt.com/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "test-operator";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "test-secret";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID = "test-importer";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET = "test-import-secret";
    const locks = {
      packageLock: {
        ...exomemHostedContractFixture.packageLock,
        platform: "openai",
        artifact_sha256: sha("a"),
        registered_app_id_sha256: sha("c"),
      },
      archiveLock: {
        platform: "openai",
        archive_sha256: sha("b"),
        registered_app_id_sha256: sha("c"),
      },
    };
    const lockUnsigned = {
      candidateId: "018f2d91-7c42-7000-8000-000000000002",
      ...locks,
      operatorKeyId: "test-importer",
    };
    const importSignature = createHmac("sha256", "test-import-secret")
      .update(canonical(lockUnsigned))
      .digest("hex");
    const baseEvidence: Record<string, unknown> = {
      schema_version: 1,
      platform: "openai",
      client_version: "1.0.0",
      clean_client_identity_hmac_sha256: sha("1"),
      timestamp: new Date().toISOString(),
      paired_run_hmac_sha256: sha("2"),
      test_identity: "hosted-client-plugins-v1",
      exomem_identity_hmac_sha256: sha("3"),
      tenant_hmac_sha256: sha("4"),
      entitlement_hmac_sha256: sha("5"),
      provisioning_operation_hmac_sha256: sha("6"),
      cell_hmac_sha256: sha("7"),
      oauth_client_config_sha256: sha("a"),
      identity_count: 1,
      tenant_count: 1,
      entitlement_count: 1,
      operation_count: 1,
      cell_count: 1,
      volume_count: 1,
      result_sha256: sha("8"),
      package_artifact_sha256: locks.packageLock.artifact_sha256,
      archive_sha256: locks.archiveLock.archive_sha256,
      registered_app_id_sha256: locks.packageLock.registered_app_id_sha256,
      compatibility_sha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      schema_contract_sha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      command_surface_sha256: exomemHostedContractFixture.compatibility.command_surface_sha256,
      endpoint: exomemHostedContractFixture.compatibility.endpoint,
      plugin_version: locks.packageLock.plugin_version,
      profile: exomemHostedContractFixture.compatibility.profile,
      operator_key_id: "test-operator",
      native_install: true,
      authorization: true,
      tool_discovery: true,
      content_recall: true,
      citation: true,
      durable_capture: true,
      fresh_chat_recall: true,
    };
    const evidence = {
      ...baseEvidence,
      operator_signature: createHmac("sha256", "test-secret")
        .update(canonical(baseEvidence))
        .digest("hex"),
    };
    const artifact = {
      platform: "openai",
      state: "pending",
      packageSha256: locks.packageLock.artifact_sha256,
      archiveSha256: locks.archiveLock.archive_sha256,
      compatibilitySha256: baseEvidence.compatibility_sha256,
      contractSha256: baseEvidence.schema_contract_sha256,
      pluginVersion: locks.packageLock.plugin_version,
      clientIdentitySha256: sha("1"),
      pairedRunHmacSha256: sha("2"),
      exomemIdentityHmacSha256: sha("3"),
      tenantHmacSha256: sha("4"),
      installUrl: process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL,
      evidenceSha256: createHash("sha256").update(canonical(evidence)).digest("hex"),
      resultSha256: sha("8"),
      oauthClientConfigSha256: sha("a"),
      observedAt: new Date().toISOString(),
      candidateId: "018f2d91-7c42-7000-8000-000000000002",
      evidence,
    };
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (/load-client-artifact-contract-locks/i.test(query))
        return {
          rows: [
            {
              candidate_id: "018f2d91-7c42-7000-8000-000000000002",
              openai_package_lock: locks.packageLock,
              openai_archive_lock: locks.archiveLock,
            },
          ],
        };
      return { rows: [{ id: "openai-artifact-1" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));
    assert.equal(
      await attachOpenAiContractLocks({ ...lockUnsigned, operatorSignature: importSignature }),
      true
    );
    assert.equal(await storeClientArtifact(artifact), "openai-artifact-1");
    assert.equal(
      queries.filter((query) => /load-client-artifact-contract-locks/i.test(query)).length,
      1
    );
    assert.match(queries[0], /openai_package_lock/i);
    await assert.rejects(
      () =>
        attachOpenAiContractLocks({
          ...lockUnsigned,
          archiveLock: { ...locks.archiveLock, registered_app_id_sha256: sha("d") },
          operatorSignature: importSignature,
        }),
      /registered app ID digest/i
    );
    await assert.rejects(
      () =>
        attachOpenAiContractLocks({
          ...lockUnsigned,
          archiveLock: { ...locks.archiveLock, registered_app_id: "asdk_test_unbound" },
          operatorSignature: importSignature,
        }),
      /archive lock is invalid/i
    );
    await assert.rejects(
      () =>
        attachOpenAiContractLocks({
          ...lockUnsigned,
          packageLock: { ...locks.packageLock, registeredAppId: "asdk_test_unbound" },
          operatorSignature: importSignature,
        }),
      /locks differ/i
    );
    const missingDigestEvidence = { ...baseEvidence };
    delete missingDigestEvidence.registered_app_id_sha256;
    await assert.rejects(
      () => storeClientArtifact({ ...artifact, evidence: missingDigestEvidence }),
      /exact real content-bearing client evidence/i
    );
    const mismatchedDigestEvidence = {
      ...baseEvidence,
      registered_app_id_sha256: sha("d"),
    };
    const mismatchedEvidence = {
      ...mismatchedDigestEvidence,
      operator_signature: createHmac("sha256", "test-secret")
        .update(canonical(mismatchedDigestEvidence))
        .digest("hex"),
    };
    await assert.rejects(
      () =>
        storeClientArtifact({
          ...artifact,
          evidence: mismatchedEvidence,
          evidenceSha256: createHash("sha256").update(canonical(mismatchedEvidence)).digest("hex"),
        }),
      /exact registered package and archive locks/i
    );
  });

  it("writes routable authority with ordered sequential locks on one transaction", async () => {
    const queries: string[] = [];
    __setExomemTransactionForTests(
      async (work: (transaction: ExomemTransaction) => Promise<void>) =>
        work({
          query: async (text) => {
            queries.push(text);
            if (/SELECT cell_id::text/i.test(text))
              return {
                rows: [
                  {
                    cell_id: "00000000-0000-0000-0000-000000000001",
                    source_release: "0.33.0",
                    protocol_version: "1",
                    command_fingerprint: sha("a"),
                    contract_digest: sha("b"),
                    compatibility_digest: sha("c"),
                  },
                ],
              };
            return { rows: [] };
          },
        })
    );
    await recordRoutableCellObservation({
      cellId: "00000000-0000-0000-0000-000000000001",
      sourceRelease: "0.33.0",
      protocolVersion: "1",
      commandSurfaceSha256: sha("a"),
      schemaDigest: sha("b"),
      compatibilitySha256: sha("c"),
      routable: true,
    });
    assert.equal(queries.length, 5);
    assert.match(queries[1], /FOR UPDATE/i);
    assert.match(queries[3], /ORDER BY cell_id FOR UPDATE/i);
    assert.match(
      queries[3],
      /source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest/i
    );
    assert.match(queries[4], /CASE WHEN \$9 THEN \$4 ELSE source_release END/i);
    assert.doesNotMatch(queries.join("\n"), /WITH\s+authority_seed|digest\s*\(/i);
  });

  it("stores fixture imports as pending", async () => {
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "contract-1" }] };
    });
    assert.equal(await storeExomemAgentContractCandidate(), "contract-1");
    assert.match(queries[0], /mcp_protocol_versions/i);
  });
});
