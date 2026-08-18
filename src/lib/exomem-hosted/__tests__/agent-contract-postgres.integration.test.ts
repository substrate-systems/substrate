import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  withExomemTransaction,
  type ExomemSql,
  type ExomemTransaction,
} from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { exomemHostedContractFixture as candidateFixture0350 } from "../agent-contract-fixture-0-35-0";
import { exomemContractFixture0541 } from "../gateway-contract-0-54-1";
import { loadOwnerInstallActions } from "../account-install-actions";
import { resolveApprovedOAuthClient } from "../oauth-store";
import {
  attachOpenAiContractLocks,
  getExomemAgentContractForOAuthAccess,
  getLiveExomemAgentContract,
  listExomemHostedRolloutStatus,
  promoteExomemHostedCohort,
  recordRoutableCellObservation,
  refreshRoutableProfileAuthorityInTransaction,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";
import { storeClientArtifact } from "../client-artifacts";
import { SqlLifecycleStore } from "../lifecycle-store";
import {
  __setPromotionProvisionerForTests,
  preparePromotionRuntimeHealth,
  PromotionRuntimePreconditionError,
  recordPromotionRuntimeAuthorityInTransaction,
} from "../promotion-runtime";
import { digestSecret, encryptSecret } from "../security";
import { routableSetDigest } from "../routable-authority";
import {
  createCanaryAssignment,
  createStagedClientRelease,
  expireCanaryAuthority,
  resolveActiveCanaryAssignment,
} from "../agent-contract-canaries";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  canonicalPromotionJson as canonical,
  evidence,
  pendingArtifactFromEvidence,
  testOnlyOpenAiLocks,
} from "./agent-contract-promotion-fixture";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;
const sha = (letter: string) => letter.repeat(64);
const promotionEnvelopeKey = Buffer.alloc(32, 0x3a);

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

async function waitForCohortLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows } = await pool!.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted) AS waiting"
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("artifact import did not wait for the cohort lock");
}

async function seedRoutableCells(): Promise<void> {
  for (const suffix of ["one", "two", "three"]) {
    const user = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`agent-contract-${suffix}@example.test`]
    );
    const tenant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_tenants (
         owner_user_id, status, desired_state, marketplace_reviewer_purpose
       ) VALUES ($1, 'active', 'running', $2) RETURNING id`,
      [user.rows[0]!.id, true]
    );
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
       tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         worker_policy, provider_ref, service_credential_ciphertext, service_credential_digest
       ) VALUES ($1, 'active', 'bound', 'running', '1', 'test',
                 '{"workerCount":1,"semantic":true,"media":false}'::jsonb, $2, $3::jsonb, $4) RETURNING id`,
      [
        tenant.rows[0]!.id,
        `promotion-provider-${suffix}`,
        JSON.stringify(
          encryptSecret(`promotion-credential-${suffix}`, { key: promotionEnvelopeKey })
        ),
        digestSecret(`promotion-credential-${suffix}`),
      ]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cell.rows[0]!.id,
      tenant.rows[0]!.id,
    ]);
  }
}

async function seedActiveReviewerAssignment(candidateId: string): Promise<{
  id: string;
  generation: number;
}> {
  const existing = await pool!.query<{ id: string; generation: string }>(
    `SELECT id::text AS id, generation
     FROM exomem_agent_contract_rollout_assignments
     WHERE candidate_id = $1::uuid AND state = 'active' AND expires_at > now()
     ORDER BY created_at, id
     LIMIT 1`,
    [candidateId]
  );
  if (existing.rows[0])
    return { id: existing.rows[0].id, generation: Number(existing.rows[0].generation) };
  const { rows } = await pool!.query<{ id: string; generation: string }>(
    `INSERT INTO exomem_agent_contract_rollout_assignments (
       tenant_id, candidate_id, generation, state, source_release, protocol_version,
       command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
       marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
     )
     SELECT tenant.id, candidate.id, COALESCE((
              SELECT MAX(existing.generation)
              FROM exomem_agent_contract_rollout_assignments AS existing
              WHERE existing.tenant_id = tenant.id
            ), 0) + 1, 'active', candidate.source_release, candidate.protocol_version,
            candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest, $2,
            true, $3, now() + interval '1 hour', now()
     FROM exomem_tenants AS tenant
     JOIN exomem_agent_contract_candidates AS candidate ON candidate.id = $1::uuid
     WHERE tenant.marketplace_reviewer_purpose = true
       AND NOT EXISTS (
         SELECT 1 FROM exomem_agent_contract_rollout_assignments AS assignment
         WHERE assignment.tenant_id = tenant.id AND assignment.state IN ('preparing', 'active')
       )
     LIMIT 1
     RETURNING id::text AS id, generation`,
    [candidateId, sha("e"), sha("9")]
  );
  assert.equal(rows.length, 1);
  return { id: rows[0]!.id, generation: Number(rows[0]!.generation) };
}

async function seedExactBoundProof(candidateId: string): Promise<void> {
  await pool!.query(
    `WITH target AS (
       SELECT id, source_release, protocol_version, command_fingerprint, schema_digest,
              compatibility_digest
       FROM exomem_agent_contract_candidates WHERE id = $1::uuid
     ), routed_cells AS (
       SELECT cell.tenant_id
       FROM exomem_routable_cell_contracts AS route
       JOIN exomem_cells AS cell ON cell.id = route.cell_id
       WHERE route.profile_id = 'hosted-alpha-agent-v1' AND route.routable
     )
     INSERT INTO exomem_agent_contract_rollout_assignments (
       tenant_id, candidate_id, generation, state, source_release, protocol_version,
       command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
       marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
     )
     SELECT routed_cells.tenant_id, target.id, COALESCE((
              SELECT MAX(existing.generation)
              FROM exomem_agent_contract_rollout_assignments AS existing
              WHERE existing.tenant_id = routed_cells.tenant_id
            ), 0) + 1, 'active', target.source_release, target.protocol_version,
            target.command_fingerprint, target.schema_digest, target.compatibility_digest, $2,
            true, $3, now() + interval '1 hour', now()
     FROM routed_cells CROSS JOIN target
     WHERE NOT EXISTS (
       SELECT 1 FROM exomem_agent_contract_rollout_assignments AS assignment
       WHERE assignment.tenant_id = routed_cells.tenant_id AND assignment.state IN ('preparing', 'active')
     )`,
    [candidateId, exomemContractFixture0541.digest, sha("9")]
  );
  await pool!.query(
    `WITH target AS (
       SELECT id, source_release, protocol_version, command_fingerprint, schema_digest,
              compatibility_digest
       FROM exomem_agent_contract_candidates WHERE id = $1::uuid
     ), bound_cells AS (
       SELECT cell.id, cell.tenant_id
       FROM exomem_routable_cell_contracts AS route
       JOIN exomem_cells AS cell ON cell.id = route.cell_id
       WHERE route.profile_id = 'hosted-alpha-agent-v1' AND route.routable
     )
     UPDATE exomem_cells AS cell
     SET lifecycle_state = 'active', routing_state = 'bound', readiness_code = 'CELL_READY',
         observed_gateway_contract_digest = $2,
         observed_command_fingerprint = target.command_fingerprint,
         observed_schema_digest = target.schema_digest,
         observed_compatibility_digest = target.compatibility_digest
     FROM bound_cells, target
     WHERE cell.id = bound_cells.id`,
    [candidateId, exomemContractFixture0541.digest]
  );
  await pool!.query(
    `INSERT INTO exomem_lifecycle_operations (
       tenant_id, cell_id, operation_type, state, idempotency_key, fence_generation, checkpoint,
       provisioner_wire_protocol, target_candidate_id, target_source_release, target_protocol_version,
       target_assignment_id, target_assignment_generation,
       target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
       target_compatibility_digest, completed_at
     )
     SELECT cell.tenant_id, cell.id, 'provision', 'succeeded',
            'promotion-proof-' || target.id::text || '-' || cell.id::text,
            tenant.fence_generation, 'bound',
            'exomem-cell-provisioner.v2', target.id, target.source_release, target.protocol_version,
            assignment.id, assignment.generation,
            $2, target.command_fingerprint, target.schema_digest, target.compatibility_digest, now()
     FROM exomem_routable_cell_contracts AS route
     JOIN exomem_cells AS cell ON cell.id = route.cell_id
     JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
     JOIN exomem_agent_contract_candidates AS target ON target.id = $1::uuid
     JOIN exomem_agent_contract_rollout_assignments AS assignment
       ON assignment.tenant_id = cell.tenant_id AND assignment.candidate_id = target.id
      AND assignment.state = 'active' AND assignment.expires_at > now()
     WHERE route.profile_id = 'hosted-alpha-agent-v1' AND route.routable`,
    [candidateId, exomemContractFixture0541.digest]
  );
}

describe("agent contract PostgreSQL constraints", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `agent_contract_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    // The promotion proof fixture models the subsequent full-identity codec.
    await admin.query(
      `ALTER TABLE "${schema}".exomem_lifecycle_operations
       DROP CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check`
    );
    await admin.query(
      `DROP TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable
       ON "${schema}".exomem_lifecycle_operations`
    );
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
    process.env.EXOMEM_CONTROL_PLANE_KEY = promotionEnvelopeKey.toString("base64url");
    __setPromotionProvisionerForTests({
      health: async (request) => ({
        live: true,
        ready: true,
        cellId: request.cellId,
        protocolVersion: request.runtimeTarget!.protocolVersion,
        releaseVersion: request.runtimeTarget!.releaseVersion,
        serviceAuthenticated: true,
        mutationAuthority: true,
        readAdmission: true,
        writeAdmission: true,
        workerPolicy: request.workerPolicy,
        runtimeIdentity: request.runtimeTarget,
        code: "CELL_READY",
      }),
    });
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
    delete process.env.EXOMEM_CONTROL_PLANE_KEY;
    __setPromotionProvisionerForTests(null);
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
      sourceRelease: exomemHostedContractFixture.sourceRelease,
      protocolVersion: fixture.agent_contract.protocol_version,
      commandSurfaceSha256: fixture.command_surface_sha256,
      schemaDigest: fixture.schema_contract_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      routable: true,
    });
    const candidateId = await storeExomemAgentContractCandidate();
    await seedExactBoundProof(candidateId);
    const pendingCandidate = await pool!.query<{
      state: string;
      package_sha256: string;
      archive_sha256: string;
      compatibility_digest: string;
      schema_digest: string;
      plugin_version: string;
    }>(
      `SELECT state, claude_package_lock->>'artifact_sha256' AS package_sha256,
              claude_archive_lock->>'archive_sha256' AS archive_sha256,
              compatibility_digest, schema_digest, claude_package_lock->>'plugin_version' AS plugin_version
       FROM exomem_agent_contract_candidates WHERE id = $1`,
      [candidateId]
    );
    assert.deepEqual(pendingCandidate.rows, [
      {
        state: "pending",
        package_sha256: exomemHostedContractFixture.packageLock.artifact_sha256,
        archive_sha256: exomemHostedContractFixture.archiveLock.archive_sha256,
        compatibility_digest: exomemHostedContractFixture.compatibility.compatibility_sha256,
        schema_digest: exomemHostedContractFixture.compatibility.schema_contract_sha256,
        plugin_version: exomemHostedContractFixture.packageLock.plugin_version,
      },
    ]);
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
    const stageCandidate = await pool!.query<{
      pending: boolean;
      compatibility: boolean;
      contract: boolean;
      package: boolean;
      archive: boolean;
      version: boolean;
    }>(
      `SELECT state = 'pending' AS pending,
              compatibility_digest = $2 AS compatibility,
              schema_digest = $3 AS contract,
              claude_package_lock->>'artifact_sha256' = $4 AS package,
              claude_archive_lock->>'archive_sha256' = $5 AS archive,
              claude_package_lock->>'plugin_version' = $6 AS version
       FROM exomem_agent_contract_candidates WHERE id = $1`,
      [
        candidateId,
        exomemHostedContractFixture.compatibility.compatibility_sha256,
        exomemHostedContractFixture.compatibility.schema_contract_sha256,
        exomemHostedContractFixture.packageLock.artifact_sha256,
        exomemHostedContractFixture.archiveLock.archive_sha256,
        exomemHostedContractFixture.packageLock.plugin_version,
      ]
    );
    assert.deepEqual(stageCandidate.rows, [
      {
        pending: true,
        compatibility: true,
        contract: true,
        package: true,
        archive: true,
        version: true,
      },
    ]);
    const stageExpiry = new Date(Date.now() + 60 * 60_000);
    const claudeStage = await createStagedClientRelease({
      candidateId,
      platform: "claude",
      packageSha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archiveSha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: exomemHostedContractFixture.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: null,
      operatorPrincipalDigest: sha("9"),
      expiresAt: stageExpiry,
    });
    const staleOpenAiStage = await createStagedClientRelease({
      candidateId,
      platform: "openai",
      packageSha256: testOnlyOpenAiLocks.packageLock.artifact_sha256,
      archiveSha256: testOnlyOpenAiLocks.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: testOnlyOpenAiLocks.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: testOnlyOpenAiLocks.packageLock.registered_app_id_sha256,
      operatorPrincipalDigest: sha("9"),
      expiresAt: stageExpiry,
    });
    await pool!.query(
      "UPDATE exomem_staged_client_releases SET state = 'failed', ended_at = now(), version = version + 1 WHERE id = $1",
      [staleOpenAiStage.id]
    );
    const openAiStage = await createStagedClientRelease({
      candidateId,
      platform: "openai",
      packageSha256: testOnlyOpenAiLocks.packageLock.artifact_sha256,
      archiveSha256: testOnlyOpenAiLocks.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: testOnlyOpenAiLocks.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: testOnlyOpenAiLocks.packageLock.registered_app_id_sha256,
      operatorPrincipalDigest: sha("9"),
      expiresAt: stageExpiry,
    });
    const assignment = await seedActiveReviewerAssignment(candidateId);
    const authorityOwner = await pool!.query<{ tenant_id: string; owner_user_id: string }>(
      `SELECT assignment.tenant_id, tenant.owner_user_id
       FROM exomem_agent_contract_rollout_assignments AS assignment
       JOIN exomem_tenants AS tenant ON tenant.id = assignment.tenant_id
       WHERE assignment.id = $1`,
      [assignment.id]
    );
    const openAiCanaryClient = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
         client_platform, oauth_client_config_sha256
       ) VALUES ($1, 'pinned', false, '["https://canary.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://canary.example.test/callback"]', 'utf8'), 'sha256'),
                 'openai', $2) RETURNING id`,
      [`canary-openai-${randomUUID()}`, sha("a")]
    );
    const openAiCanaryCredential = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id,
         fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
       ) VALUES ('openai', 'internal_canary', decode($1, 'hex'), '$argon2id$integration', $2, $3,
                 $4, $5, $6, $7, $8, 'two-platform-evidence', $9, decode($10, 'hex'),
                 now() + interval '1 hour') RETURNING id`,
      [
        sha("b"),
        authorityOwner.rows[0]!.owner_user_id,
        authorityOwner.rows[0]!.tenant_id,
        candidateId,
        assignment.id,
        assignment.generation,
        openAiStage.id,
        openAiCanaryClient.rows[0]!.id,
        sha("c"),
        sha("d"),
      ]
    );
    const openAiCanaryFamily = await pool!.query<{ id: string }>(
      `WITH grant_row AS (
         INSERT INTO exomem_oauth_grants (
           user_id, tenant_id, client_id, resource, scopes, refresh_allowed, reviewer_credential_id,
           candidate_id, assignment_id, assignment_generation, staged_client_release_id
         ) VALUES ($1, $2, $3, 'https://substratesystems.io/api/exomem/mcp/v1',
                   ARRAY['exomem.read'], true, $4, $5, $6, $7, $8) RETURNING id
       ) INSERT INTO exomem_oauth_token_families (
         grant_id, client_id, expires_at, candidate_id, assignment_id, assignment_generation,
         staged_client_release_id, reviewer_credential_id
       ) SELECT id, $3, now() + interval '1 hour', $5, $6, $7, $8, $4 FROM grant_row RETURNING id`,
      [
        authorityOwner.rows[0]!.owner_user_id,
        authorityOwner.rows[0]!.tenant_id,
        openAiCanaryClient.rows[0]!.id,
        openAiCanaryCredential.rows[0]!.id,
        candidateId,
        assignment.id,
        assignment.generation,
        openAiStage.id,
      ]
    );
    const staleCanaryCredential = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id,
         fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
       ) VALUES ('openai', 'internal_canary', decode($1, 'hex'), '$argon2id$integration', $2, $3,
                 $4, $5, $6, $7, $8, 'stale-stage', $9, decode($10, 'hex'),
                 now() + interval '1 hour') RETURNING id`,
      [
        sha("e"),
        authorityOwner.rows[0]!.owner_user_id,
        authorityOwner.rows[0]!.tenant_id,
        candidateId,
        assignment.id,
        assignment.generation,
        staleOpenAiStage.id,
        (
          await pool!.query<{ id: string }>(
            `INSERT INTO exomem_oauth_clients (
             client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
             client_platform, oauth_client_config_sha256
           ) VALUES ($1, 'pinned', false, '["https://stale.example.test/callback"]'::jsonb,
                     digest(convert_to('["https://stale.example.test/callback"]', 'utf8'), 'sha256'),
                     'openai', $2) RETURNING id`,
            [`stale-openai-${randomUUID()}`, sha("a")]
          )
        ).rows[0]!.id,
        sha("f"),
        sha("1"),
      ]
    );
    const staleCanaryFamily = await pool!.query<{ id: string; grant_id: string }>(
      `WITH grant_row AS (
         INSERT INTO exomem_oauth_grants (
           user_id, tenant_id, client_id, resource, scopes, refresh_allowed, reviewer_credential_id,
           candidate_id, assignment_id, assignment_generation, staged_client_release_id
         ) VALUES ($1, $2, $3, 'https://substratesystems.io/api/exomem/mcp/v1',
                   ARRAY['exomem.read'], true, $4, $5, $6, $7, $8) RETURNING id
       ) INSERT INTO exomem_oauth_token_families (
         grant_id, client_id, expires_at, candidate_id, assignment_id, assignment_generation,
         staged_client_release_id, reviewer_credential_id
       ) SELECT id, $3, now() + interval '1 hour', $5, $6, $7, $8, $4 FROM grant_row RETURNING id, grant_id`,
      [
        authorityOwner.rows[0]!.owner_user_id,
        authorityOwner.rows[0]!.tenant_id,
        (
          await pool!.query<{ oauth_client_id: string }>(
            "SELECT oauth_client_id FROM exomem_marketplace_reviewer_credentials WHERE id = $1",
            [staleCanaryCredential.rows[0]!.id]
          )
        ).rows[0]!.oauth_client_id,
        staleCanaryCredential.rows[0]!.id,
        candidateId,
        assignment.id,
        assignment.generation,
        staleOpenAiStage.id,
      ]
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const makeArtifact = pendingArtifactFromEvidence;
    const claudeEvidence = evidence("claude", "integration-secret", randomUUID(), {
      candidateId,
      stageId: claudeStage.id,
      assignmentId: assignment.id,
      assignmentGeneration: assignment.generation,
    });
    const openAiEvidence = evidence("openai", "integration-secret", randomUUID(), {
      candidateId,
      stageId: openAiStage.id,
      assignmentId: assignment.id,
      assignmentGeneration: assignment.generation,
    });
    const claudeId = await storeClientArtifact(makeArtifact("claude", claudeEvidence));
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT credential.revoked_at IS NULL AS credential_active,
                  family.revoked_at IS NULL AS family_active
           FROM exomem_marketplace_reviewer_credentials AS credential
           JOIN exomem_oauth_token_families AS family ON family.reviewer_credential_id = credential.id
           WHERE credential.id = $1 AND family.id = $2`,
          [openAiCanaryCredential.rows[0]!.id, openAiCanaryFamily.rows[0]!.id]
        )
      ).rows[0],
      { credential_active: true, family_active: true }
    );
    const openAiId = await storeClientArtifact(makeArtifact("openai", openAiEvidence));
    const claudeClientId = `claude-${randomUUID()}`;
    const openAiClientId = `openai-${randomUUID()}`;
    await pool!.query(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, metadata_provenance, redirect_uris,
         redirect_uris_digest, client_platform, oauth_client_config_sha256
       ) VALUES
         ($1, 'pinned', true, '{}'::jsonb, '["https://example.test/callback"]'::jsonb,
          digest(convert_to('["https://example.test/callback"]', 'utf8'), 'sha256'), 'claude', $2),
         ($3, 'pinned', true, '{}'::jsonb, '["https://example.test/callback"]'::jsonb,
          digest(convert_to('["https://example.test/callback"]', 'utf8'), 'sha256'), 'openai', $2)`,
      [claudeClientId, sha("a"), openAiClientId]
    );
    const status = (await listExomemHostedRolloutStatus()).find(
      (entry) => entry.candidateId === candidateId
    );
    assert.ok(status, "operator status must expose the pending candidate");
    assert.equal(status.routableObservationFresh, true);
    assert.ok(status.routableSetDigest, "operator status must expose the promotion CAS");
    const routableSetDigest = status.routableSetDigest;
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId,
        claudeArtifactId: claudeId,
        openaiArtifactId: openAiId,
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: routableSetDigest,
        claudeEvidence,
        openaiEvidence: openAiEvidence,
      }),
      "promoted"
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT grant_row.revoked_at IS NOT NULL AS grant_revoked,
                  family.revoked_at IS NOT NULL AS family_revoked
           FROM exomem_oauth_grants AS grant_row
           JOIN exomem_oauth_token_families AS family ON family.id = $2
           WHERE grant_row.id = $1`,
          [staleCanaryFamily.rows[0]!.grant_id, staleCanaryFamily.rows[0]!.id]
        )
      ).rows[0],
      { grant_revoked: true, family_revoked: true }
    );
    assert.equal(
      (
        await pool!.query("SELECT revoked_at FROM exomem_oauth_token_families WHERE id = $1", [
          openAiCanaryFamily.rows[0]!.id,
        ])
      ).rows[0]?.revoked_at,
      null
    );
    assert.deepEqual(
      (
        await pool!.query<{ state: string; ended: boolean }>(
          `SELECT state, ended_at IS NOT NULL AS ended
           FROM exomem_agent_contract_rollout_assignments
           WHERE id = $1`,
          [assignment.id]
        )
      ).rows,
      [{ state: "retired", ended: true }]
    );
    assert.deepEqual(
      (
        await pool!.query<{ platform: string; state: string; ended: boolean }>(
          `SELECT platform, state, ended_at IS NOT NULL AS ended
           FROM exomem_staged_client_releases
           WHERE id = ANY($1::uuid[])
           ORDER BY platform`,
          [[claudeStage.id, openAiStage.id]]
        )
      ).rows,
      [
        { platform: "claude", state: "retired", ended: true },
        { platform: "openai", state: "retired", ended: true },
      ]
    );
    assert.deepEqual((await getLiveExomemAgentContract())?.mcpProtocolVersions, [
      "2025-11-25",
      "2025-06-18",
    ]);
    await pool!.query(
      `UPDATE exomem_agent_contract_profile_authority
       SET observed_at = now() - interval '6 minutes'
       WHERE profile_id = 'hosted-alpha-agent-v1'`
    );
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId,
        claudeArtifactId: claudeId,
        openaiArtifactId: openAiId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: routableSetDigest,
        claudeEvidence,
        openaiEvidence: openAiEvidence,
      }),
      "already_live"
    );

    const replacementCandidateId = await storeExomemAgentContractCandidate();
    await seedExactBoundProof(replacementCandidateId);
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
    const replacementClaudeStage = await createStagedClientRelease({
      candidateId: replacementCandidateId,
      platform: "claude",
      packageSha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archiveSha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: exomemHostedContractFixture.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: null,
      operatorPrincipalDigest: sha("9"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const replacementOpenAiStage = await createStagedClientRelease({
      candidateId: replacementCandidateId,
      platform: "openai",
      packageSha256: testOnlyOpenAiLocks.packageLock.artifact_sha256,
      archiveSha256: testOnlyOpenAiLocks.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: testOnlyOpenAiLocks.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: testOnlyOpenAiLocks.packageLock.registered_app_id_sha256,
      operatorPrincipalDigest: sha("9"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const replacementAssignment = await seedActiveReviewerAssignment(replacementCandidateId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replacementClaudeEvidence = evidence("claude", "integration-secret", randomUUID(), {
      candidateId: replacementCandidateId,
      stageId: replacementClaudeStage.id,
      assignmentId: replacementAssignment.id,
      assignmentGeneration: replacementAssignment.generation,
    });
    const replacementOpenAiEvidence = evidence("openai", "integration-secret", randomUUID(), {
      candidateId: replacementCandidateId,
      stageId: replacementOpenAiStage.id,
      assignmentId: replacementAssignment.id,
      assignmentGeneration: replacementAssignment.generation,
    });
    const replacementClaudeId = await storeClientArtifact(
      makeArtifact("claude", replacementClaudeEvidence)
    );
    const replacementOpenAiId = await storeClientArtifact(
      makeArtifact("openai", replacementOpenAiEvidence)
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
          expectedRoutableCellDigest: routableSetDigest,
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
    await pool!.query(
      `UPDATE exomem_oauth_clients
       SET admission_mode = 'cimd', metadata_document_digest = digest('expired', 'sha256'),
           metadata_fetched_at = now() - interval '10 minutes', metadata_ttl_seconds = 300,
           metadata_expires_at = now() - interval '1 second', cimd_host = 'example.test'
       WHERE client_platform = 'openai' AND oauth_client_config_sha256 = $1`,
      [sha("a")]
    );
    const authorityBeforeLateFailure = (
      await pool!.query(
        `SELECT authority.routable_set_digest, authority.observed_at,
                cell.last_liveness_at, cell.last_readiness_at,
                cell.observed_gateway_contract_digest, cell.observed_command_fingerprint,
                cell.observed_schema_digest, cell.observed_compatibility_digest
         FROM exomem_agent_contract_profile_authority AS authority
         CROSS JOIN LATERAL (
           SELECT * FROM exomem_cells ORDER BY id LIMIT 1
         ) AS cell
         WHERE authority.profile_id = 'hosted-alpha-agent-v1'`
      )
    ).rows;
    assert.equal(
      await promoteExomemHostedCohort({
        candidateId: replacementCandidateId,
        claudeArtifactId: replacementClaudeId,
        openaiArtifactId: replacementOpenAiId,
        expectedLiveCandidateId: candidateId,
        expectedRoutableCellDigest: routableSetDigest,
        claudeEvidence: replacementClaudeEvidence,
        openaiEvidence: replacementOpenAiEvidence,
      }),
      "precondition_failed"
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT authority.routable_set_digest, authority.observed_at,
                  cell.last_liveness_at, cell.last_readiness_at,
                  cell.observed_gateway_contract_digest, cell.observed_command_fingerprint,
                  cell.observed_schema_digest, cell.observed_compatibility_digest
           FROM exomem_agent_contract_profile_authority AS authority
           CROSS JOIN LATERAL (
             SELECT * FROM exomem_cells ORDER BY id LIMIT 1
           ) AS cell
           WHERE authority.profile_id = 'hosted-alpha-agent-v1'`
        )
      ).rows,
      authorityBeforeLateFailure
    );
    assert.deepEqual(
      (await pool!.query<{ id: string }>("SELECT id FROM exomem_hosted_alpha_cohort")).rows.map(
        (row) => row.id
      ),
      [candidateId]
    );
    await pool!.query(
      `UPDATE exomem_oauth_clients
       SET admission_mode = 'pinned', metadata_document_digest = NULL, metadata_fetched_at = NULL,
           metadata_ttl_seconds = NULL, metadata_expires_at = NULL, cimd_host = NULL
       WHERE client_platform = 'openai' AND oauth_client_config_sha256 = $1`,
      [sha("a")]
    );
    const fencedCell = (
      await pool!.query<{ cell_id: string }>(
        `SELECT route.cell_id::text AS cell_id
         FROM exomem_routable_cell_contracts AS route
         JOIN exomem_lifecycle_operations AS operation ON operation.cell_id = route.cell_id
         WHERE route.profile_id = 'hosted-alpha-agent-v1' AND route.routable
           AND operation.target_candidate_id = $1::uuid
           AND operation.state = 'succeeded' AND operation.checkpoint = 'bound'
           AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
         ORDER BY route.cell_id DESC
         LIMIT 1`,
        [replacementCandidateId]
      )
    ).rows[0]!;
    const promotionObservationsBeforeFence = (
      await pool!.query(
        `SELECT authority.routable_set_digest, authority.observed_at,
                cell.id::text AS cell_id, cell.last_liveness_at, cell.last_readiness_at,
                cell.observed_gateway_contract_digest, cell.observed_command_fingerprint,
                cell.observed_schema_digest, cell.observed_compatibility_digest
         FROM exomem_agent_contract_profile_authority AS authority
         JOIN exomem_routable_cell_contracts AS route
           ON route.profile_id = authority.profile_id AND route.routable
         JOIN exomem_cells AS cell ON cell.id = route.cell_id
         WHERE authority.profile_id = 'hosted-alpha-agent-v1'
         ORDER BY cell.id`
      )
    ).rows;
    await pool!.query(
      `CREATE FUNCTION fence_runtime_promotion_cell() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '${fencedCell.cell_id}'::uuid THEN
           UPDATE exomem_tenants SET fence_generation = fence_generation + 1 WHERE id = NEW.tenant_id;
         END IF;
         RETURN NEW;
       END;
       $$;
       CREATE TRIGGER fence_runtime_promotion_cell
       BEFORE UPDATE OF last_liveness_at ON exomem_cells
       FOR EACH ROW EXECUTE FUNCTION fence_runtime_promotion_cell();`
    );
    try {
      assert.equal(
        await promoteExomemHostedCohort({
          candidateId: replacementCandidateId,
          claudeArtifactId: replacementClaudeId,
          openaiArtifactId: replacementOpenAiId,
          expectedLiveCandidateId: candidateId,
          expectedRoutableCellDigest: routableSetDigest,
          claudeEvidence: replacementClaudeEvidence,
          openaiEvidence: replacementOpenAiEvidence,
        }),
        "precondition_failed"
      );
    } finally {
      await pool!.query("DROP TRIGGER IF EXISTS fence_runtime_promotion_cell ON exomem_cells");
      await pool!.query("DROP FUNCTION IF EXISTS fence_runtime_promotion_cell()");
    }
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT authority.routable_set_digest, authority.observed_at,
                  cell.id::text AS cell_id, cell.last_liveness_at, cell.last_readiness_at,
                  cell.observed_gateway_contract_digest, cell.observed_command_fingerprint,
                  cell.observed_schema_digest, cell.observed_compatibility_digest
           FROM exomem_agent_contract_profile_authority AS authority
           JOIN exomem_routable_cell_contracts AS route
             ON route.profile_id = authority.profile_id AND route.routable
           JOIN exomem_cells AS cell ON cell.id = route.cell_id
           WHERE authority.profile_id = 'hosted-alpha-agent-v1'
           ORDER BY cell.id`
        )
      ).rows,
      promotionObservationsBeforeFence
    );
    const owner = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`cohort-reader-${randomUUID()}@example.test`]
    );
    const ownerTenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
      [owner.rows[0]!.id]
    );
    await pool!.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
      [ownerTenant.rows[0]!.id]
    );
    await pool!.query(`
      CREATE FUNCTION pause_hosted_cohort_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(0, 714229);
        RETURN NEW;
      END;
      $$
    `);
    await pool!.query(`
      CREATE TRIGGER pause_hosted_cohort_promotion
      BEFORE UPDATE OF state ON exomem_agent_contract_candidates
      FOR EACH ROW WHEN (NEW.id = '${replacementCandidateId}'::uuid AND NEW.state = 'live')
      EXECUTE FUNCTION pause_hosted_cohort_promotion()
    `);
    const lockClient = await pool!.connect();
    let lockHeld = false;
    let replacement: ReturnType<typeof promoteExomemHostedCohort> | undefined;
    try {
      try {
        await lockClient.query("SELECT pg_advisory_lock(0, 714229)");
        lockHeld = true;
        replacement = promoteExomemHostedCohort({
          candidateId: replacementCandidateId,
          claudeArtifactId: replacementClaudeId,
          openaiArtifactId: replacementOpenAiId,
          expectedLiveCandidateId: candidateId,
          expectedRoutableCellDigest: routableSetDigest,
          claudeEvidence: replacementClaudeEvidence,
          openaiEvidence: replacementOpenAiEvidence,
        });
        const deadline = Date.now() + 10_000;
        let waiterReached = false;
        while (Date.now() < deadline) {
          const waiter = await pool!.query<{ waiting: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND classid = 0 AND objid = 714229 AND objsubid = 2 AND NOT granted) AS waiting"
          );
          if (waiter.rows[0]?.waiting) {
            waiterReached = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(waiterReached, true, "replacement must pause before commit");
        assert.deepEqual(
          (await pool!.query<{ id: string }>("SELECT id FROM exomem_hosted_alpha_cohort")).rows.map(
            (row) => row.id
          ),
          [candidateId]
        );
        assert.deepEqual(
          await loadOwnerInstallActions(owner.rows[0]!.id, ownerTenant.rows[0]!.id),
          [
            {
              platform: "claude",
              version: exomemHostedContractFixture.packageLock.plugin_version,
              installUrl: process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL!,
            },
            {
              platform: "openai",
              version: testOnlyOpenAiLocks.packageLock.plugin_version,
              installUrl: process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL!,
            },
          ]
        );
      } finally {
        let releaseWithError = false;
        try {
          if (lockHeld) await lockClient.query("SELECT pg_advisory_unlock(0, 714229)");
        } catch (unlockError) {
          releaseWithError = true;
          throw unlockError;
        } finally {
          lockClient.release(releaseWithError);
        }
      }
      assert.equal(await replacement!, "promoted");
    } catch (error) {
      if (replacement) await replacement.catch(() => undefined);
      throw error;
    }
    assert.deepEqual(
      (await pool!.query<{ id: string }>("SELECT id FROM exomem_hosted_alpha_cohort")).rows.map(
        (row) => row.id
      ),
      [replacementCandidateId]
    );
    assert.equal(
      (await loadOwnerInstallActions(owner.rows[0]!.id, ownerTenant.rows[0]!.id)).length,
      2
    );
    assert.equal((await resolveApprovedOAuthClient(claudeClientId))?.clientId, claudeClientId);
    assert.equal((await resolveApprovedOAuthClient(openAiClientId))?.clientId, openAiClientId);
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
          [[replacementCandidateId, invalidCandidateId]]
        )
      ).rows,
      [
        { id: replacementCandidateId, state: "live" },
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
      sourceRelease: exomemHostedContractFixture.sourceRelease,
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
          exomemHostedContractFixture.sourceRelease,
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
      source_release: exomemHostedContractFixture.sourceRelease,
      protocol_version: fixture.agent_contract.protocol_version,
      command_fingerprint: fixture.command_surface_sha256,
      contract_digest: fixture.schema_contract_sha256,
      compatibility_digest: fixture.compatibility_sha256,
    });
  });

  it("keeps ordinary discovery on live A while exact reviewer bearer lineage selects pending B", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const cellId = randomUUID();
    const ordinaryUserId = randomUUID();
    const ordinaryTenantId = randomUUID();
    const ordinaryCellId = randomUUID();
    const candidateId = randomUUID();
    const assignmentId = randomUUID();
    const fixture = candidateFixture0350.compatibility;
    await pool!.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `selection-${randomUUID()}@example.test`,
    ]);
    await pool!.query(
      `INSERT INTO exomem_tenants (
         id, owner_user_id, status, desired_state, marketplace_reviewer_purpose
       ) VALUES ($1, $2, 'active', 'running', true)`,
      [tenantId, userId]
    );
    await pool!.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', '0.35.0')`,
      [cellId, tenantId]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cellId,
      tenantId,
    ]);
    await pool!.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      ordinaryUserId,
      `ordinary-selection-${randomUUID()}@example.test`,
    ]);
    await pool!.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [ordinaryTenantId, ordinaryUserId]
    );
    await pool!.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', '0.34.0')`,
      [ordinaryCellId, ordinaryTenantId]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      ordinaryCellId,
      ordinaryTenantId,
    ]);
    await pool!.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        ordinaryCellId,
        exomemHostedContractFixture.compatibility.profile,
        exomemHostedContractFixture.sourceRelease,
        exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
        exomemHostedContractFixture.compatibility.command_surface_sha256,
        exomemHostedContractFixture.compatibility.schema_contract_sha256,
        exomemHostedContractFixture.compatibility.compatibility_sha256,
      ]
    );
    await pool!.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, mcp_protocol_versions, contract,
         claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)`,
      [
        candidateId,
        fixture.profile,
        fixture.endpoint,
        candidateFixture0350.sourceRelease,
        fixture.command_surface_sha256,
        fixture.schema_contract_sha256,
        fixture.compatibility_sha256,
        fixture.agent_contract.protocol_version,
        JSON.stringify(["2025-11-25", "2025-06-18"]),
        JSON.stringify(fixture),
        JSON.stringify(candidateFixture0350.packageLock),
        JSON.stringify(candidateFixture0350.archiveLock),
      ]
    );
    await pool!.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
       ) VALUES ($1, $2, $3, 7, 'active', $4, $5, $6, $7, $8, $9,
                 true, $10, now() + interval '1 hour', now())`,
      [
        assignmentId,
        tenantId,
        candidateId,
        candidateFixture0350.sourceRelease,
        fixture.agent_contract.protocol_version,
        fixture.command_surface_sha256,
        fixture.schema_contract_sha256,
        fixture.compatibility_sha256,
        sha("e"),
        sha("f"),
      ]
    );
    await pool!.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        cellId,
        fixture.profile,
        candidateFixture0350.sourceRelease,
        fixture.agent_contract.protocol_version,
        fixture.command_surface_sha256,
        fixture.schema_contract_sha256,
        fixture.compatibility_sha256,
      ]
    );

    const lineage = { tenantId, candidateId, assignmentId, assignmentGeneration: BigInt(7) };
    assert.equal(
      (await getExomemAgentContractForOAuthAccess({ tenantId: ordinaryTenantId }))?.sourceRelease,
      exomemHostedContractFixture.sourceRelease
    );
    assert.equal((await getExomemAgentContractForOAuthAccess(lineage))?.sourceRelease, "0.35.0");
    assert.equal(
      await getExomemAgentContractForOAuthAccess({ ...lineage, assignmentGeneration: BigInt(8) }),
      null
    );
    await pool!.query(
      "UPDATE exomem_routable_cell_contracts SET source_release = '0.24.0' WHERE cell_id = $1",
      [cellId]
    );
    assert.equal(await getExomemAgentContractForOAuthAccess(lineage), null);
  });

  it("activates a preparing assignment atomically and rolls back every published effect on descendant revocation failure", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const priorCellId = randomUUID();
    const replacementCellId = randomUUID();
    const candidateId = randomUUID();
    const assignmentId = randomUUID();
    const operationId = randomUUID();
    const clientId = randomUUID();
    const gatewayDigest = sha("a");
    const commandFingerprint = sha("b");
    const schemaDigest = sha("c");
    const compatibilityDigest = sha("d");

    await pool!.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `preparing-bind-${randomUUID()}@example.test`,
    ]);
    await pool!.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, legacy_unmetered, marketplace_reviewer_purpose)
       VALUES ($1, $2, 'active', 'running', true, true)`,
      [tenantId, userId]
    );
    await pool!.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
         observed_schema_digest, observed_compatibility_digest
       ) VALUES
         ($1, $3, 'active', 'bound', 'running', '0', '2026.07.30', 'CELL_READY', NULL, NULL, NULL, NULL),
         ($2, $3, 'provisioning', 'unbound', 'running', '0', '2026.07.30', 'CELL_READY', NULL, NULL, NULL, NULL)`,
      [priorCellId, replacementCellId, tenantId]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      priorCellId,
      tenantId,
    ]);
    await pool!.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, 'hosted-alpha-agent-v1', '2026.07.30', '0', $2, $3, $4, true)`,
      [priorCellId, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool!.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test',
                 '2026.07.30', $2, $3, $4, '0', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [candidateId, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool!.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at
       ) VALUES ($1, $2, $3, 1, 'preparing', '2026.07.30', '0', $4, $5, $6, $7,
                 true, $8, now() + interval '1 hour')`,
      [
        assignmentId,
        tenantId,
        candidateId,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
        gatewayDigest,
        sha("e"),
      ]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_clients (
         id, client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform,
         oauth_client_config_sha256
       ) VALUES ($1, $2, 'pinned', true, '["https://preparing-bind.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://preparing-bind.example.test/callback"]', 'utf8'), 'sha256'),
                 'claude', $3)`,
      [clientId, `preparing-bind-client-${randomUUID()}`, sha("f")]
    );
    const legacyGrant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
       VALUES ($1, $2, $3, 'https://substratesystems.io/api/exomem/mcp/v1', ARRAY['exomem.read'])
       RETURNING id`,
      [userId, tenantId, clientId]
    );
    const legacyFamily = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
       VALUES ($1, $2, now() + interval '1 hour') RETURNING id`,
      [legacyGrant.rows[0]!.id, clientId]
    );
    await pool!.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, expected_previous_cell_id, operation_type, state, idempotency_key,
         fence_generation, checkpoint, lease_owner, lease_expires_at,
         target_candidate_id, target_assignment_id, target_assignment_generation,
         target_source_release, target_protocol_version, target_gateway_contract_digest,
         target_command_fingerprint, target_schema_digest, target_compatibility_digest
       ) VALUES ($1, $2, $3, $4, 'provision', 'running', 'preparing-bind', 1, 'readiness-proved',
                 'bind-worker', now() + interval '1 hour', $5, $6, 1, '2026.07.30', '0', $7, $8, $9, $10)`,
      [
        operationId,
        tenantId,
        replacementCellId,
        priorCellId,
        candidateId,
        assignmentId,
        gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );
    await pool!.query(`
      CREATE FUNCTION fail_preparing_bind_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced preparing bind revocation failure';
      END;
      $$;
      CREATE TRIGGER fail_preparing_bind_revocation
      BEFORE UPDATE OF revoked_at ON exomem_oauth_grants
      FOR EACH ROW EXECUTE FUNCTION fail_preparing_bind_revocation();
    `);

    await assert.rejects(
      () => new SqlLifecycleStore().bindCandidate(operationId, "bind-worker"),
      /forced preparing bind revocation failure/
    );
    await pool!.query(
      "DROP TRIGGER fail_preparing_bind_revocation ON exomem_oauth_grants; DROP FUNCTION fail_preparing_bind_revocation()"
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT assignment.state AS assignment_state,
                  assignment.activated_at IS NOT NULL AS assignment_activated,
                  tenant.bound_cell_id = $2::uuid AS prior_still_bound,
                  prior.routing_state = 'bound' AS prior_still_routed,
                  prior_observation.routable AS prior_observation_routable,
                  replacement.routing_state = 'unbound' AS replacement_unbound,
                  replacement_observation.cell_id IS NULL AS replacement_unobserved,
                  grant_row.revoked_at IS NULL AS legacy_grant_active,
                  family.revoked_at IS NULL AS legacy_family_active
           FROM exomem_agent_contract_rollout_assignments AS assignment
           JOIN exomem_tenants AS tenant ON tenant.id = assignment.tenant_id
           JOIN exomem_cells AS prior ON prior.id = $2::uuid
           JOIN exomem_cells AS replacement ON replacement.id = $3::uuid
           JOIN exomem_routable_cell_contracts AS prior_observation
             ON prior_observation.cell_id = prior.id AND prior_observation.profile_id = 'hosted-alpha-agent-v1'
           LEFT JOIN exomem_routable_cell_contracts AS replacement_observation
             ON replacement_observation.cell_id = replacement.id AND replacement_observation.profile_id = 'hosted-alpha-agent-v1'
           JOIN exomem_oauth_grants AS grant_row ON grant_row.id = $4::uuid
           JOIN exomem_oauth_token_families AS family ON family.id = $5::uuid
           WHERE assignment.id = $1::uuid`,
          [
            assignmentId,
            priorCellId,
            replacementCellId,
            legacyGrant.rows[0]!.id,
            legacyFamily.rows[0]!.id,
          ]
        )
      ).rows,
      [
        {
          assignment_state: "preparing",
          assignment_activated: false,
          prior_still_bound: true,
          prior_still_routed: true,
          prior_observation_routable: true,
          replacement_unbound: true,
          replacement_unobserved: true,
          legacy_grant_active: true,
          legacy_family_active: true,
        },
      ]
    );

    assert.equal(await new SqlLifecycleStore().bindCandidate(operationId, "bind-worker"), true);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT assignment.state AS assignment_state,
                  assignment.activated_at IS NOT NULL AS assignment_activated,
                  tenant.bound_cell_id = $2::uuid AS replacement_bound,
                  prior.routing_state = 'retiring' AS prior_retired,
                  prior_observation.routable AS prior_observation_routable,
                  replacement.routing_state = 'bound' AS replacement_routed,
                  replacement_observation.routable AS replacement_observation_routable,
                  grant_row.revoked_at IS NOT NULL AS legacy_grant_revoked,
                  family.revoked_at IS NOT NULL AS legacy_family_revoked
           FROM exomem_agent_contract_rollout_assignments AS assignment
           JOIN exomem_tenants AS tenant ON tenant.id = assignment.tenant_id
           JOIN exomem_cells AS prior ON prior.id = $3::uuid
           JOIN exomem_cells AS replacement ON replacement.id = $2::uuid
           JOIN exomem_routable_cell_contracts AS prior_observation
             ON prior_observation.cell_id = prior.id AND prior_observation.profile_id = 'hosted-alpha-agent-v1'
           JOIN exomem_routable_cell_contracts AS replacement_observation
             ON replacement_observation.cell_id = replacement.id AND replacement_observation.profile_id = 'hosted-alpha-agent-v1'
           JOIN exomem_oauth_grants AS grant_row ON grant_row.id = $4::uuid
           JOIN exomem_oauth_token_families AS family ON family.id = $5::uuid
           WHERE assignment.id = $1::uuid`,
          [
            assignmentId,
            replacementCellId,
            priorCellId,
            legacyGrant.rows[0]!.id,
            legacyFamily.rows[0]!.id,
          ]
        )
      ).rows,
      [
        {
          assignment_state: "active",
          assignment_activated: true,
          replacement_bound: true,
          prior_retired: true,
          prior_observation_routable: false,
          replacement_routed: true,
          replacement_observation_routable: true,
          legacy_grant_revoked: true,
          legacy_family_revoked: true,
        },
      ]
    );
  });

  it("rejects evidence after a serially prior reviewer assignment termination", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    const stage = await createStagedClientRelease({
      candidateId,
      platform: "claude",
      packageSha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archiveSha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: exomemHostedContractFixture.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: null,
      operatorPrincipalDigest: sha("9"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const assignment = await seedActiveReviewerAssignment(candidateId);
    const signed = evidence("claude", "integration-secret", randomUUID(), {
      candidateId,
      stageId: stage.id,
      assignmentId: assignment.id,
      assignmentGeneration: assignment.generation,
    });
    const artifact = {
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
      oauthClientConfigSha256: signed.oauth_client_config_sha256,
      observedAt: signed.timestamp,
      candidateId: signed.contract_candidate_id,
      stagedClientReleaseId: signed.staged_client_release_id,
      assignmentId: signed.assignment_id,
      assignmentGeneration: signed.assignment_generation,
      evidence: signed,
    };
    const terminator = await pool!.connect();
    try {
      await terminator.query("BEGIN");
      await terminator.query(
        "SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))"
      );
      await terminator.query(
        `UPDATE exomem_agent_contract_rollout_assignments
         SET state = 'failed', activated_at = NULL, ended_at = now(),
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [assignment.id]
      );
      const importing = storeClientArtifact(artifact);
      await waitForCohortLockWaiter();
      await terminator.query("COMMIT");
      await assert.rejects(() => importing, /artifact stage precondition failed/);
    } finally {
      await terminator.query("ROLLBACK").catch(() => undefined);
      terminator.release();
    }
    const artifacts = await pool!.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM exomem_client_artifacts WHERE staged_client_release_id = $1",
      [stage.id]
    );
    assert.equal(artifacts.rows[0]?.count, "0");
  });

  it("permits a fresh stage after a terminal declaration but rejects two current stages", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    const input = {
      candidateId,
      platform: "claude" as const,
      packageSha256: exomemHostedContractFixture.packageLock.artifact_sha256,
      archiveSha256: exomemHostedContractFixture.archiveLock.archive_sha256,
      compatibilitySha256: exomemHostedContractFixture.compatibility.compatibility_sha256,
      contractSha256: exomemHostedContractFixture.compatibility.schema_contract_sha256,
      pluginVersion: exomemHostedContractFixture.packageLock.plugin_version,
      oauthClientConfigSha256: sha("a"),
      registeredAppIdSha256: null,
      operatorPrincipalDigest: sha("9"),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    };
    const first = await createStagedClientRelease(input);
    await assert.rejects(
      () => createStagedClientRelease(input),
      /exomem_staged_client_releases_candidate_platform_current_idx/
    );
    await pool!.query(
      `UPDATE exomem_staged_client_releases
       SET state = 'failed', ended_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1`,
      [first.id]
    );
    const replacement = await createStagedClientRelease(input);
    assert.notEqual(replacement.id, first.id);
  });

  it("rolls back every prior observation when a later runtime authority row loses its fence", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    const candidate = (
      await pool!.query<{
        source_release: string;
        protocol_version: string;
        command_fingerprint: string;
        schema_digest: string;
        compatibility_digest: string;
      }>(
        `SELECT source_release, protocol_version, command_fingerprint, schema_digest, compatibility_digest
         FROM exomem_agent_contract_candidates WHERE id = $1`,
        [candidateId]
      )
    ).rows[0]!;
    const cellIds: string[] = [];
    for (const suffix of ["first", "second"]) {
      const user = await pool!.query<{ id: string }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING id",
        [`runtime-race-${suffix}-${randomUUID()}@example.test`]
      );
      const tenant = await pool!.query<{ id: string; fence_generation: string }>(
        `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose)
         VALUES ($1, 'active', 'running', true) RETURNING id, fence_generation`,
        [user.rows[0]!.id]
      );
      const credential = `runtime-race-credential-${suffix}`;
      const cell = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_cells (
           tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
           worker_policy, provider_ref, service_credential_ciphertext, service_credential_digest
         ) VALUES ($1, 'active', 'bound', 'running', $2, $3,
                   '{"workerCount":1,"semantic":true,"media":false}'::jsonb, $4, $5::jsonb, $6)
         RETURNING id`,
        [
          tenant.rows[0]!.id,
          candidate.protocol_version,
          candidate.source_release,
          `runtime-race-provider-${suffix}`,
          JSON.stringify(encryptSecret(credential, { key: promotionEnvelopeKey })),
          digestSecret(credential),
        ]
      );
      cellIds.push(cell.rows[0]!.id);
      await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
        cell.rows[0]!.id,
        tenant.rows[0]!.id,
      ]);
      const assignment = await pool!.query<{ id: string; generation: string }>(
        `INSERT INTO exomem_agent_contract_rollout_assignments (
           tenant_id, candidate_id, generation, state, source_release, protocol_version,
           command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
           marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
         ) VALUES ($1, $2, 1, 'active', $3, $4, $5, $6, $7, $8, true, $9,
                   now() + interval '1 hour', now()) RETURNING id, generation`,
        [
          tenant.rows[0]!.id,
          candidateId,
          candidate.source_release,
          candidate.protocol_version,
          candidate.command_fingerprint,
          candidate.schema_digest,
          candidate.compatibility_digest,
          exomemContractFixture0541.digest,
          sha("9"),
        ]
      );
      await pool!.query(
        `INSERT INTO exomem_routable_cell_contracts (
           cell_id, profile_id, source_release, protocol_version, command_fingerprint,
           contract_digest, compatibility_digest, routable
         ) VALUES ($1, 'hosted-alpha-agent-v1', $2, $3, $4, $5, $6, true)`,
        [
          cell.rows[0]!.id,
          candidate.source_release,
          candidate.protocol_version,
          candidate.command_fingerprint,
          candidate.schema_digest,
          candidate.compatibility_digest,
        ]
      );
      await pool!.query(
        `INSERT INTO exomem_lifecycle_operations (
           tenant_id, cell_id, operation_type, state, idempotency_key, fence_generation, checkpoint,
           provisioner_wire_protocol, target_candidate_id, target_assignment_id, target_assignment_generation,
           target_source_release, target_protocol_version, target_gateway_contract_digest,
           target_command_fingerprint, target_schema_digest, target_compatibility_digest, completed_at
         ) VALUES ($1, $2, 'provision', 'succeeded', $3, $4, 'bound',
                   'exomem-cell-provisioner.v2', $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
        [
          tenant.rows[0]!.id,
          cell.rows[0]!.id,
          `runtime-race-${suffix}`,
          tenant.rows[0]!.fence_generation,
          candidateId,
          assignment.rows[0]!.id,
          assignment.rows[0]!.generation,
          candidate.source_release,
          candidate.protocol_version,
          exomemContractFixture0541.digest,
          candidate.command_fingerprint,
          candidate.schema_digest,
          candidate.compatibility_digest,
        ]
      );
    }
    const priorRouteStates = (
      await pool!.query<{ cell_id: string; routable: boolean }>(
        "SELECT cell_id::text AS cell_id, routable FROM exomem_routable_cell_contracts"
      )
    ).rows;
    await pool!.query(
      "UPDATE exomem_routable_cell_contracts SET routable = false WHERE NOT (cell_id = ANY($1::uuid[]))",
      [cellIds]
    );
    const routes = (
      await pool!.query<{
        cell_id: string;
        source_release: string;
        protocol_version: string;
        command_fingerprint: string;
        contract_digest: string;
        compatibility_digest: string;
      }>(
        `SELECT cell_id::text AS cell_id, source_release, protocol_version, command_fingerprint,
                contract_digest, compatibility_digest
         FROM exomem_routable_cell_contracts WHERE cell_id = ANY($1::uuid[]) ORDER BY cell_id`,
        [cellIds]
      )
    ).rows;
    const rejectedCellId = routes[1]!.cell_id;
    const expected = routableSetDigest("hosted-alpha-agent-v1", routes);
    const originalCell = (
      await pool!.query<{ service_credential_digest: Buffer; tenant_id: string }>(
        "SELECT service_credential_digest, tenant_id::text AS tenant_id FROM exomem_cells WHERE id = $1::uuid",
        [routes[0]!.cell_id]
      )
    ).rows[0]!;
    const originalCredentialDigest = originalCell.service_credential_digest;
    await pool!.query(
      "UPDATE exomem_cells SET service_credential_digest = NULL WHERE id = $1::uuid",
      [routes[0]!.cell_id]
    );
    assert.equal(
      await preparePromotionRuntimeHealth({ candidateId, expectedRoutableCellDigest: expected }),
      null
    );
    await pool!.query(
      "UPDATE exomem_cells SET service_credential_digest = $2 WHERE id = $1::uuid",
      [routes[0]!.cell_id, digestSecret("wrong-runtime-race-credential")]
    );
    assert.equal(
      await preparePromotionRuntimeHealth({ candidateId, expectedRoutableCellDigest: expected }),
      null
    );
    await pool!.query(
      "UPDATE exomem_cells SET service_credential_digest = $2 WHERE id = $1::uuid",
      [routes[0]!.cell_id, originalCredentialDigest]
    );
    const originalFenceGeneration = (
      await pool!.query<{ fence_generation: string }>(
        "SELECT fence_generation FROM exomem_tenants WHERE id = $1::uuid",
        [originalCell.tenant_id]
      )
    ).rows[0]!.fence_generation;
    await pool!.query(
      "UPDATE exomem_tenants SET fence_generation = fence_generation + 1 WHERE id = $1::uuid",
      [originalCell.tenant_id]
    );
    assert.equal(
      await preparePromotionRuntimeHealth({ candidateId, expectedRoutableCellDigest: expected }),
      null
    );
    await pool!.query("UPDATE exomem_tenants SET fence_generation = $2 WHERE id = $1::uuid", [
      originalCell.tenant_id,
      originalFenceGeneration,
    ]);
    const probes = await preparePromotionRuntimeHealth({
      candidateId,
      expectedRoutableCellDigest: expected,
    });
    assert.ok(probes && probes.length === 2, "non-null credential digests must form strict probes");
    await pool!.query(
      `CREATE FUNCTION reject_second_runtime_observation() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.id = '${rejectedCellId}'::uuid THEN RETURN NULL; END IF;
         RETURN NEW;
       END;
       $$;
       CREATE TRIGGER reject_second_runtime_observation
       BEFORE UPDATE OF readiness_code ON exomem_cells
       FOR EACH ROW EXECUTE FUNCTION reject_second_runtime_observation();`
    );
    const assignmentId = probes![0]!.operation.target!.assignmentId;
    const assignmentSourceRelease = probes![0]!.operation.target!.sourceRelease;
    let assignmentTriggerDisabled = false;
    try {
      await assert.rejects(
        () =>
          withExomemTransaction((transaction) =>
            recordPromotionRuntimeAuthorityInTransaction({
              transaction,
              candidateId,
              expectedRoutableCellDigest: expected,
              probes: probes!,
              refreshAuthority: refreshRoutableProfileAuthorityInTransaction,
            })
          ),
        PromotionRuntimePreconditionError
      );
      await pool!.query("DROP TRIGGER reject_second_runtime_observation ON exomem_cells");
      await pool!.query("DROP FUNCTION reject_second_runtime_observation()");
      assert.deepEqual(
        (
          await pool!.query(
            "SELECT id::text AS id, last_liveness_at FROM exomem_cells WHERE id = ANY($1::uuid[]) ORDER BY id",
            [cellIds]
          )
        ).rows,
        cellIds.sort().map((id) => ({ id, last_liveness_at: null }))
      );
      await pool!.query(
        "ALTER TABLE exomem_agent_contract_rollout_assignments DISABLE TRIGGER exomem_agent_contract_rollout_assignment_immutable"
      );
      assignmentTriggerDisabled = true;
      await pool!.query(
        `UPDATE exomem_agent_contract_rollout_assignments
         SET source_release = 'migrated-assignment-release'
         WHERE id = $1::uuid`,
        [assignmentId]
      );
      assert.equal(
        await preparePromotionRuntimeHealth({ candidateId, expectedRoutableCellDigest: expected }),
        null
      );
      await assert.rejects(
        () =>
          withExomemTransaction((transaction) =>
            recordPromotionRuntimeAuthorityInTransaction({
              transaction,
              candidateId,
              expectedRoutableCellDigest: expected,
              probes: probes!,
              refreshAuthority: refreshRoutableProfileAuthorityInTransaction,
            })
          ),
        PromotionRuntimePreconditionError
      );
      await pool!.query(
        "UPDATE exomem_agent_contract_rollout_assignments SET source_release = $2 WHERE id = $1::uuid",
        [assignmentId, assignmentSourceRelease]
      );
      await pool!.query(
        "ALTER TABLE exomem_agent_contract_rollout_assignments ENABLE TRIGGER exomem_agent_contract_rollout_assignment_immutable"
      );
      assignmentTriggerDisabled = false;
    } finally {
      await pool!.query("DROP TRIGGER IF EXISTS reject_second_runtime_observation ON exomem_cells");
      await pool!.query("DROP FUNCTION IF EXISTS reject_second_runtime_observation()");
      for (const route of priorRouteStates) {
        await pool!.query(
          "UPDATE exomem_routable_cell_contracts SET routable = $2 WHERE cell_id = $1",
          [route.cell_id, route.routable]
        );
      }
      if (assignmentTriggerDisabled) {
        await pool!.query(
          "UPDATE exomem_agent_contract_rollout_assignments SET source_release = $2 WHERE id = $1::uuid",
          [assignmentId, assignmentSourceRelease]
        );
        await pool!.query(
          "ALTER TABLE exomem_agent_contract_rollout_assignments ENABLE TRIGGER exomem_agent_contract_rollout_assignment_immutable"
        );
      }
    }
  });

  it("serializes two concurrent reviewer assignment creators and decodes PostgreSQL bigint generations", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    const tenant = await pool!.query<{ id: string }>(
      `SELECT tenant.id
       FROM exomem_tenants AS tenant
       WHERE tenant.marketplace_reviewer_purpose = true
         AND NOT EXISTS (
           SELECT 1 FROM exomem_agent_contract_rollout_assignments AS assignment
           WHERE assignment.tenant_id = tenant.id AND assignment.state IN ('preparing', 'active')
         )
       LIMIT 1`
    );
    assert.ok(tenant.rows[0]?.id);
    const attempts = await Promise.allSettled([
      createCanaryAssignment({
        tenantId: tenant.rows[0]!.id,
        candidateId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        operatorPrincipalDigest: sha("9"),
      }),
      createCanaryAssignment({
        tenantId: tenant.rows[0]!.id,
        candidateId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        operatorPrincipalDigest: sha("9"),
      }),
    ]);
    const created = attempts.find(
      (
        attempt
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof createCanaryAssignment>>> =>
        attempt.status === "fulfilled"
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.ok(created);
    assert.ok(Number.isSafeInteger(created.value.generation));
    assert.ok(created.value.generation > 0);
    await pool!.query(
      "UPDATE exomem_agent_contract_rollout_assignments SET state = 'active', activated_at = now() WHERE id = $1",
      [created.value.id]
    );
    const resolved = await resolveActiveCanaryAssignment(tenant.rows[0]!.id);
    assert.equal(resolved?.generation, created.value.generation);
    await pool!.query(
      "UPDATE exomem_agent_contract_rollout_assignments SET expires_at = created_at + interval '1 microsecond' WHERE id = $1",
      [created.value.id]
    );
    await expireCanaryAuthority();
    const expired = await pool!.query<{ state: string; activated_cleared: boolean }>(
      "SELECT state, activated_at IS NULL AS activated_cleared FROM exomem_agent_contract_rollout_assignments WHERE id = $1",
      [created.value.id]
    );
    assert.deepEqual(expired.rows, [{ state: "expired", activated_cleared: true }]);
  });
});
