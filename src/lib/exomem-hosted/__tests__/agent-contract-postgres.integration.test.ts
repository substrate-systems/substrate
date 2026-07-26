import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemSql,
  type ExomemTransaction,
} from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import {
  attachOpenAiContractLocks,
  getLiveExomemAgentContract,
  promoteExomemHostedCohort,
  recordRoutableCellObservation,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import { storeClientArtifact } from "../client-artifacts";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;
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

function sql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

function transactionSql(client: PoolClient): ExomemSql & ExomemTransaction {
  const tagged = sql(client) as ExomemSql & ExomemTransaction;
  tagged.query = async (text, values = []) => {
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
  return tagged;
}

async function transaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await work(transactionSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedRoutableCells(): Promise<void> {
  for (const suffix of ["one", "two"]) {
    const user = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`agent-contract-${suffix}@example.test`]
    );
    const tenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
      [user.rows[0]!.id]
    );
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
       ) VALUES ($1, 'active', 'bound', 'running', '1', 'test') RETURNING id`,
      [tenant.rows[0]!.id]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cell.rows[0]!.id,
      tenant.rows[0]!.id,
    ]);
  }
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
    oauth_client_config_hmac_sha256: sha("a"),
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
    schema = `agent_contract_it_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString(), max: 3 });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
    await seedRoutableCells();
    process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL = "https://claude.ai/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL = "https://chatgpt.com/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "integration-operator";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "integration-secret";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID = "integration-importer";
    process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET = "integration-import-secret";
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    delete process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID;
    delete process.env.EXOMEM_HOSTED_PROMOTION_SECRET;
    delete process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID;
    delete process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET;
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
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
    const makeArtifact = (
      platform: "claude" | "openai",
      signed: Record<string, unknown>,
      artifactCandidateId: string
    ) => ({
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
      oauthClientConfigHmacSha256: signed.oauth_client_config_hmac_sha256,
      observedAt: new Date().toISOString(),
      candidateId: artifactCandidateId,
      evidence: signed,
    });
    const claudeEvidence = evidence("claude", "integration-secret", randomUUID());
    const openAiEvidence = evidence("openai", "integration-secret", randomUUID());
    const claudeId = await storeClientArtifact(makeArtifact("claude", claudeEvidence, candidateId));
    const openAiId = await storeClientArtifact(makeArtifact("openai", openAiEvidence, candidateId));
    await pool!.query(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, metadata_provenance, redirect_uris,
         redirect_uris_digest, client_platform, oauth_client_config_hmac_sha256
       ) VALUES
         ($1, 'pinned', true, '{}'::jsonb, '["https://example.test/callback"]'::jsonb,
          digest(convert_to('["https://example.test/callback"]', 'utf8'), 'sha256'), 'claude', $2),
         ($3, 'pinned', true, '{}'::jsonb, '["https://example.test/callback"]'::jsonb,
          digest(convert_to('["https://example.test/callback"]', 'utf8'), 'sha256'), 'openai', $2)`,
      [randomUUID(), sha("a"), randomUUID()]
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
      await promoteExomemHostedCohort({
        candidateId,
        claudeArtifactId: claudeId,
        openaiArtifactId: openAiId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: authority.rows[0]!.routable_set_digest,
        claudeEvidence,
        openaiEvidence: openAiEvidence,
      }),
      "promoted"
    );
    assert.deepEqual((await getLiveExomemAgentContract())?.mcpProtocolVersions, [
      "2025-11-25",
      "2025-06-18",
    ]);
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId,
        claudeArtifactId: claudeId,
        openaiArtifactId: openAiId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: authority.rows[0]!.routable_set_digest,
        claudeEvidence,
        openaiEvidence: openAiEvidence,
      }),
      "already_live"
    );

    const replacementCandidateId = await storeExomemAgentContractCandidate();
    const replacementUnsigned = {
      candidateId: replacementCandidateId,
      packageLock: testOnlyOpenAiLocks.packageLock,
      archiveLock: testOnlyOpenAiLocks.archiveLock,
      operatorKeyId: "integration-importer",
    };
    assert.equal(
      await attachOpenAiContractLocks({
        ...replacementUnsigned,
        operatorSignature: createHmac("sha256", "integration-import-secret")
          .update(canonical(replacementUnsigned))
          .digest("hex"),
      }),
      true
    );
    const replacementClaudeEvidence = evidence("claude", "integration-secret", randomUUID());
    const replacementOpenAiEvidence = evidence("openai", "integration-secret", randomUUID());
    const replacementClaudeId = await storeClientArtifact(
      makeArtifact("claude", replacementClaudeEvidence, replacementCandidateId)
    );
    const replacementOpenAiId = await storeClientArtifact(
      makeArtifact("openai", replacementOpenAiEvidence, replacementCandidateId)
    );
    const mismatchedOpenAiUnsigned: Record<string, unknown> = {
      ...replacementOpenAiEvidence,
      tenant_hmac_sha256: sha("f"),
    };
    delete mismatchedOpenAiUnsigned.operator_signature;
    const mismatchedOpenAiEvidence = {
      ...mismatchedOpenAiUnsigned,
      operator_signature: createHmac("sha256", "integration-secret")
        .update(canonical(mismatchedOpenAiUnsigned))
        .digest("hex"),
    };
    await assert.rejects(
      () =>
        promoteExomemHostedCohort({
          candidateId: replacementCandidateId,
          claudeArtifactId: replacementClaudeId,
          openaiArtifactId: replacementOpenAiId,
          expectedLiveCandidateId: candidateId,
          expectedRoutableCellDigest: authority.rows[0]!.routable_set_digest,
          claudeEvidence: replacementClaudeEvidence,
          openaiEvidence: mismatchedOpenAiEvidence,
        }),
      /same Hosted cohort/
    );
    assert.deepEqual(
      (await pool!.query<{ id: string }>("SELECT id FROM exomem_hosted_alpha_cohort")).rows.map(
        (row) => row.id
      ),
      [candidateId]
    );
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId: replacementCandidateId,
        claudeArtifactId: replacementClaudeId,
        openaiArtifactId: replacementOpenAiId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: authority.rows[0]!.routable_set_digest,
        claudeEvidence: replacementClaudeEvidence,
        openaiEvidence: replacementOpenAiEvidence,
      }),
      "promoted"
    );
    assert.deepEqual(
      (await pool!.query<{ id: string }>("SELECT id FROM exomem_hosted_alpha_cohort")).rows.map(
        (row) => row.id
      ),
      [replacementCandidateId]
    );
    assert.deepEqual(
      (
        await pool!.query<{ id: string; state: string }>(
          "SELECT id, state FROM exomem_agent_contract_candidates WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[candidateId, replacementCandidateId]]
        )
      ).rows.sort((left, right) => left.id.localeCompare(right.id)),
      [
        { id: candidateId, state: "retired" },
        { id: replacementCandidateId, state: "live" },
      ].sort((left, right) => left.id.localeCompare(right.id))
    );

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
