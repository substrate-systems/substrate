import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import {
  attachOpenAiContractLocks,
  getLiveExomemAgentContract,
  promoteExomemAgentContractCandidate,
  recordRoutableCellObservation,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import {
  demoteClientArtifact,
  promoteClientArtifact,
  storeClientArtifact,
} from "../client-artifacts";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
const sha = (letter: string) => letter.repeat(64);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sql(pool: Pool): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await pool.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

const testOnlyOpenAiLocks = {
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
} as const;

function locksFor(platform: "claude" | "openai") {
  return platform === "claude"
    ? {
        packageLock: exomemHostedContractFixture.packageLock,
        archiveLock: exomemHostedContractFixture.archiveLock,
      }
    : testOnlyOpenAiLocks;
}

function evidence(
  platform: "claude" | "openai",
  secret: string,
  suffix: string
): Record<string, unknown> {
  const fixture = exomemHostedContractFixture;
  const locks = locksFor(platform);
  const unsigned: Record<string, unknown> = {
    schema_version: 1,
    platform,
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
    result_sha256: createHash("sha256").update(suffix).digest("hex"),
    package_artifact_sha256: locks.packageLock.artifact_sha256,
    archive_sha256: locks.archiveLock.archive_sha256,
    ...(platform === "openai"
      ? { registered_app_id_sha256: testOnlyOpenAiLocks.packageLock.registered_app_id_sha256 }
      : {}),
    compatibility_sha256: fixture.compatibility.compatibility_sha256,
    schema_contract_sha256: fixture.compatibility.schema_contract_sha256,
    command_surface_sha256: fixture.compatibility.command_surface_sha256,
    endpoint: fixture.compatibility.endpoint,
    plugin_version: locks.packageLock.plugin_version,
    profile: fixture.compatibility.profile,
    operator_key_id: "integration-operator",
    native_install: true,
    authorization: true,
    tool_discovery: true,
    content_recall: true,
    citation: true,
    durable_capture: true,
    fresh_chat_recall: true,
  };
  return {
    ...unsigned,
    operator_signature: createHmac("sha256", secret).update(canonical(unsigned)).digest("hex"),
  };
}

describe("agent contract PostgreSQL constraints", { skip: !databaseUrl }, () => {
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    await pool.query("SELECT 1");
    __setExomemSqlForTests(sql(pool));
    process.env.DATABASE_URL = databaseUrl;
    process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL = "https://claude.ai/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL = "https://chatgpt.com/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "integration-operator";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "integration-secret";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID = "integration-importer";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET = "integration-import-secret";
  });

  after(async () => {
    __setExomemSqlForTests(null);
    delete process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID;
    delete process.env.EXOMEM_HOSTED_PROMOTION_SECRET;
    delete process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID;
    delete process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET;
    delete process.env.DATABASE_URL;
    await pool?.end();
  });

  it("serializes public replacement of a live artifact before promoting its successor", async () => {
    const makeArtifact = (signed: Record<string, unknown>) => ({
      platform: "claude",
      state: "pending",
      packageSha256: signed.package_artifact_sha256,
      archiveSha256: signed.archive_sha256,
      compatibilitySha256: signed.compatibility_sha256,
      contractSha256: signed.schema_contract_sha256,
      pluginVersion: signed.plugin_version,
      clientIdentitySha256: signed.clean_client_identity_hmac_sha256,
      pairedRunHmacSha256: signed.paired_run_hmac_sha256,
      exomemIdentityHmacSha256: signed.exomem_identity_hmac_sha256,
      tenantHmacSha256: signed.tenant_hmac_sha256,
      installUrl: process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL,
      evidenceSha256: createHash("sha256").update(canonical(signed)).digest("hex"),
      resultSha256: signed.result_sha256,
      observedAt: new Date().toISOString(),
      evidence: signed,
    });
    const firstEvidence = evidence("claude", "integration-secret", randomUUID());
    const firstId = await storeClientArtifact(makeArtifact(firstEvidence));
    assert.equal(
      await promoteClientArtifact({
        artifactId: firstId,
        platform: "claude",
        evidence: firstEvidence,
      }),
      true
    );
    const secondEvidence = evidence("claude", "integration-secret", randomUUID());
    const secondId = await storeClientArtifact(makeArtifact(secondEvidence));
    assert.equal(
      await promoteClientArtifact({
        artifactId: secondId,
        platform: "claude",
        evidence: secondEvidence,
      }),
      true
    );
    const replaced = await pool!.query<{ id: string; state: string }>(
      "SELECT id, state FROM exomem_client_artifacts WHERE id = ANY($1::uuid[])",
      [[firstId, secondId]]
    );
    assert.deepEqual(
      replaced.rows
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((row) => row.state)
        .sort(),
      ["live", "retired"]
    );
    assert.equal(await demoteClientArtifact(secondId, sha("9")), true);
    const row = await pool!.query<{ state: string; promoted_at: Date; failed_at: Date }>(
      "SELECT state, promoted_at, failed_at FROM exomem_client_artifacts WHERE id = $1",
      [secondId]
    );
    assert.equal(row.rows[0]?.state, "failed");
    assert.ok(row.rows[0]?.promoted_at);
    assert.ok(row.rows[0]?.failed_at);
  });

  it("fails contract promotion closed while the exact OpenAI package lock is absent", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    assert.equal(
      await promoteExomemAgentContractCandidate({
        candidateId,
        expectedRoutableCellDigest: sha("0"),
      }),
      false
    );
  });

  it("accepts test-signed OpenAI evidence only after test-only exact locks are operator-imported and pairs both live rows", async () => {
    const fixture = exomemHostedContractFixture.compatibility;
    const routableCell = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_cells ORDER BY id LIMIT 1"
    );
    assert.ok(
      routableCell.rows[0]?.id,
      "guarded PostgreSQL database requires an isolated test cell"
    );
    await recordRoutableCellObservation({
      cellId: routableCell.rows[0]!.id,
      sourceRelease: fixture.source_release,
      protocolVersion: fixture.agent_contract.protocol_version,
      commandSurfaceSha256: fixture.command_surface_sha256,
      schemaDigest: fixture.schema_contract_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      routable: true,
    });
    const candidateId = await storeExomemAgentContractCandidate();
    const lockUnsigned = {
      candidateId,
      packageLock: testOnlyOpenAiLocks.packageLock,
      archiveLock: testOnlyOpenAiLocks.archiveLock,
      operatorKeyId: "integration-importer",
    };
    const operatorSignature = createHmac("sha256", "integration-import-secret")
      .update(canonical(lockUnsigned))
      .digest("hex");
    assert.equal(await attachOpenAiContractLocks({ ...lockUnsigned, operatorSignature }), true);
    const makeArtifact = (platform: "claude" | "openai", signed: Record<string, unknown>) => ({
      platform,
      state: "pending",
      packageSha256: signed.package_artifact_sha256,
      archiveSha256: signed.archive_sha256,
      compatibilitySha256: signed.compatibility_sha256,
      contractSha256: signed.schema_contract_sha256,
      pluginVersion: signed.plugin_version,
      clientIdentitySha256: signed.clean_client_identity_hmac_sha256,
      pairedRunHmacSha256: signed.paired_run_hmac_sha256,
      exomemIdentityHmacSha256: signed.exomem_identity_hmac_sha256,
      tenantHmacSha256: signed.tenant_hmac_sha256,
      installUrl:
        platform === "claude"
          ? process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL
          : process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL,
      evidenceSha256: createHash("sha256").update(canonical(signed)).digest("hex"),
      resultSha256: signed.result_sha256,
      observedAt: new Date().toISOString(),
      evidence: signed,
    });
    const claudeEvidence = evidence("claude", "integration-secret", randomUUID());
    const openAiEvidence = evidence("openai", "integration-secret", randomUUID());
    const claudeId = await storeClientArtifact(makeArtifact("claude", claudeEvidence));
    const openAiId = await storeClientArtifact(makeArtifact("openai", openAiEvidence));
    assert.equal(
      await promoteClientArtifact({
        artifactId: claudeId,
        platform: "claude",
        evidence: claudeEvidence,
      }),
      true
    );
    assert.equal(
      await promoteClientArtifact({
        artifactId: openAiId,
        platform: "openai",
        evidence: openAiEvidence,
      }),
      true
    );
    const authority = await pool!.query<{ routable_set_digest: string }>(
      "SELECT routable_set_digest FROM exomem_agent_contract_profile_authority WHERE profile_id = $1",
      [fixture.profile]
    );
    assert.ok(
      authority.rows[0]?.routable_set_digest,
      "requires a public routable authority observation"
    );
    assert.equal(
      await promoteExomemAgentContractCandidate({
        candidateId,
        expectedRoutableCellDigest: authority.rows[0]!.routable_set_digest,
      }),
      true
    );
    assert.deepEqual((await getLiveExomemAgentContract())?.mcpProtocolVersions, [
      "2025-11-25",
      "2025-06-18",
    ]);

    const invalidCandidateId = await storeExomemAgentContractCandidate();
    for (const versions of [[null], [42], ["2025-11-25", "2025-11-25"], ["not-a-date"]]) {
      await assert.rejects(
        pool!.query(
          "UPDATE exomem_agent_contract_candidates SET mcp_protocol_versions = $1::jsonb WHERE id = $2",
          [JSON.stringify(versions), invalidCandidateId]
        ),
        /exomem_agent_contract_candidates_mcp_protocol_versions_check/i
      );
    }
    assert.deepEqual(
      (
        await pool!.query<{ id: string; state: string }>(
          "SELECT id, state FROM exomem_agent_contract_candidates WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[candidateId, invalidCandidateId]]
        )
      ).rows,
      [
        { id: candidateId, state: "live" },
        { id: invalidCandidateId, state: "pending" },
      ].sort((left, right) => left.id.localeCompare(right.id))
    );
  });

  it("serializes two distinct public routable cells without losing full identities", async () => {
    const cells = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_cells ORDER BY id LIMIT 2"
    );
    assert.equal(
      cells.rows.length,
      2,
      "guarded PostgreSQL database requires two isolated test cells"
    );
    const fixture = exomemHostedContractFixture.compatibility;
    const observation = {
      sourceRelease: fixture.source_release,
      protocolVersion: fixture.agent_contract.protocol_version,
      commandSurfaceSha256: fixture.command_surface_sha256,
      schemaDigest: fixture.schema_contract_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      routable: true,
    };
    await Promise.all(
      cells.rows.map((cell) => recordRoutableCellObservation({ ...observation, cellId: cell.id }))
    );
    const identities = cells.rows
      .map((cell) =>
        JSON.stringify([
          fixture.profile,
          cell.id,
          fixture.source_release,
          fixture.agent_contract.protocol_version,
          fixture.command_surface_sha256,
          fixture.schema_contract_sha256,
          fixture.compatibility_sha256,
        ])
      )
      .sort();
    const expectedDigest = createHash("sha256").update(identities.join(",")).digest("hex");
    const authority = await pool!.query<{
      routable_cell_count: number;
      routable_set_digest: string;
      source_release: string;
      protocol_version: string;
      command_fingerprint: string;
      contract_digest: string;
      compatibility_digest: string;
    }>(
      "SELECT routable_cell_count, routable_set_digest, source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest FROM exomem_agent_contract_profile_authority WHERE profile_id = $1",
      [fixture.profile]
    );
    assert.deepEqual(authority.rows[0], {
      routable_cell_count: 2,
      routable_set_digest: expectedDigest,
      source_release: fixture.source_release,
      protocol_version: fixture.agent_contract.protocol_version,
      command_fingerprint: fixture.command_surface_sha256,
      contract_digest: fixture.schema_contract_sha256,
      compatibility_digest: fixture.compatibility_sha256,
    });
  });
});
