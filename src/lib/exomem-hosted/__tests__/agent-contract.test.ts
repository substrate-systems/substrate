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
import {
  attachOpenAiContractLocks,
  demoteExomemAgentContractCandidate,
  promoteExomemAgentContractCandidate,
  recordRoutableCellObservation,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import {
  demoteClientArtifact,
  promoteClientArtifact,
  storeClientArtifact,
} from "../client-artifacts";

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
  it("imports only the exact checked fixture and preserves its ordered raw schemas", () => {
    assert.equal(
      exomemHostedContractFixture.sourceCommit,
      "08f1cee281bd0dbcaf82094421c11d6be04dc5c2"
    );
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
      observedAt: new Date().toISOString(),
      evidence,
    };
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "artifact-1" }] };
    });
    const transactionQueries: string[] = [];
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        transactionQueries.push(strings.join("?"));
        return { rows: [{ id: "artifact-1" }] };
      })
    );
    assert.equal(await storeClientArtifact(artifact), "artifact-1");
    await promoteClientArtifact({
      artifactId: "00000000-0000-0000-0000-000000000001",
      platform: "claude",
      evidence,
    });
    assert.match(queries[0], /INSERT INTO exomem_client_artifacts/i);
    assert.match(
      transactionQueries[0],
      /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i
    );
    assert.match(transactionQueries[1], /package_sha256/i);
    assert.equal(
      await demoteClientArtifact("00000000-0000-0000-0000-000000000001", sha("9")),
      true
    );
    assert.match(
      transactionQueries[2],
      /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i
    );
    assert.match(transactionQueries[3], /UPDATE exomem_client_artifacts/i);
    await assert.rejects(
      () =>
        promoteClientArtifact({
          artifactId: "00000000-0000-0000-0000-000000000001",
          platform: "claude",
          evidence: { ...evidence, operator_signature: sha("0") },
        }),
      /signature is invalid/i
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
      candidateId: "00000000-0000-0000-0000-000000000002",
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
      observedAt: new Date().toISOString(),
      evidence,
    };
    const queries: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (/load-openai-contract-locks/i.test(query))
        return {
          rows: [
            {
              candidate_id: "00000000-0000-0000-0000-000000000002",
              openai_package_lock: locks.packageLock,
              openai_archive_lock: locks.archiveLock,
            },
          ],
        };
      return { rows: [{ id: "openai-artifact-1" }] };
    });
    const transactionQueries: string[] = [];
    let authoritativeCandidateId = "00000000-0000-0000-0000-000000000002";
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        const query = strings.join("?");
        transactionQueries.push(query);
        if (/load-openai-contract-locks/i.test(query))
          return {
            rows: [
              {
                candidate_id: authoritativeCandidateId,
                openai_package_lock: locks.packageLock,
                openai_archive_lock: locks.archiveLock,
              },
            ],
          };
        if (
          /promote-client-artifact/i.test(query) &&
          authoritativeCandidateId !== "00000000-0000-0000-0000-000000000002"
        )
          return { rows: [] };
        return { rows: [{ id: "openai-artifact-1" }] };
      })
    );
    assert.equal(
      await attachOpenAiContractLocks({ ...lockUnsigned, operatorSignature: importSignature }),
      true
    );
    assert.equal(await storeClientArtifact(artifact), "openai-artifact-1");
    assert.equal(
      await promoteClientArtifact({
        artifactId: "00000000-0000-0000-0000-000000000003",
        platform: "openai",
        evidence,
      }),
      true
    );
    assert.equal(queries.filter((query) => /load-openai-contract-locks/i.test(query)).length, 1);
    assert.match(queries[0], /openai_package_lock/i);
    assert.match(queries[0], /created_at DESC, id DESC/i);
    assert.match(
      transactionQueries[0],
      /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i
    );
    assert.match(transactionQueries[1], /load-openai-contract-locks/i);
    assert.match(transactionQueries[2], /UPDATE exomem_client_artifacts SET state = 'live'/i);
    assert.match(transactionQueries[2], /contract_candidate_id/i);
    assert.match(transactionQueries[2], /registered_app_id_sha256/i);
    authoritativeCandidateId = "00000000-0000-0000-0000-000000000009";
    assert.equal(
      await promoteClientArtifact({
        artifactId: "00000000-0000-0000-0000-000000000003",
        platform: "openai",
        evidence,
      }),
      false
    );
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
      /registered app ID digest/i
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
    const transactionQueries: string[] = [];
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        transactionQueries.push(strings.join("?"));
        return { rows: [{ id: "contract-1" }] };
      })
    );
    assert.equal(await storeExomemAgentContractCandidate(), "contract-1");
    assert.equal(
      await promoteExomemAgentContractCandidate({
        candidateId: "00000000-0000-0000-0000-000000000004",
        expectedRoutableCellDigest: sha("9"),
      }),
      true
    );
    assert.match(
      transactionQueries[0],
      /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i
    );
    assert.match(
      transactionQueries[1],
      /UPDATE exomem_agent_contract_candidates SET state = 'live'/i
    );
    assert.match(transactionQueries[1], /candidate\.mcp_protocol_versions IS NOT NULL/i);
    assert.match(
      transactionQueries[1],
      /jsonb_array_length\(candidate\.mcp_protocol_versions\) BETWEEN 1 AND 8/i
    );
    assert.match(
      transactionQueries[1],
      /exomem_mcp_protocol_versions_are_valid\(candidate\.mcp_protocol_versions\)/i
    );
    assert.match(
      transactionQueries[1],
      /retired AS \([\s\S]*state = 'live'[\s\S]*EXISTS \(SELECT 1 FROM exact_cells\)[\s\S]*EXISTS \(SELECT 1 FROM evidence\)/i
    );
    assert.match(
      transactionQueries[1],
      /promoted AS \([\s\S]*SET state = 'live'[\s\S]*EXISTS \(SELECT 1 FROM exact_cells\)[\s\S]*EXISTS \(SELECT 1 FROM evidence\)/i
    );
    assert.equal(
      await demoteExomemAgentContractCandidate("00000000-0000-0000-0000-000000000004"),
      true
    );
    assert.match(
      transactionQueries[2],
      /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i
    );
    assert.match(
      transactionQueries[3],
      /UPDATE exomem_agent_contract_candidates[\s\S]*state = 'retired'/i
    );
  });
});
