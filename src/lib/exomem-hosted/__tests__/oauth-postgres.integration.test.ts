import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { exomemHostedContractFixture as candidateFixture0350 } from "../agent-contract-fixture-0-35-0";
import {
  createCanaryAssignment,
  createStagedClientRelease,
  expireCanaryAuthority,
  failCanaryAssignment,
} from "../agent-contract-canaries";
import { storeRetainedExomemAgentContractCandidate } from "../agent-contract-store";
import { EXOMEM_ALPHA_CAPACITY } from "../oauth-admission";
import { ExomemHostedError } from "../errors";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  createInviteRecord,
  findExomemSessionByDigest,
  redeemInviteAtomic,
  type ExomemSql,
} from "../db";
import { SqlLifecycleStore } from "../lifecycle-store";
import {
  admitFirstOAuthInviteAtomic,
  attachExistingOwnerAuthorizationAtomic,
  createAuthorizationTransaction,
  findActiveOAuthAccessToken,
  findMcpOAuthAccessToken,
  issueOAuthTokensFromCodeAtomic,
  pruneExpiredOAuthState,
  registerAdmittedCimdClient,
  resolveApprovedOAuthClient,
  revokeOAuthAccountForOwnerTenantAtomic,
  revokeOAuthTokenForClient,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";
import {
  createInternalCanaryReviewerCredentialAtomic,
  createMarketplaceReviewerOAuthSessionAtomic,
  createOrRotateMarketplaceReviewerCredentialAtomic,
  findMarketplaceReviewerCredentialForAuthentication,
  getMarketplaceReviewerCredentialStatus,
  revokeInternalCanaryReviewerCredentialAtomic,
  revokeMarketplaceReviewerCredentialAtomic,
} from "../reviewer-access-store";
import { revokeConflictingCanaryOAuthLineageInTransaction } from "../agent-contract-canaries";
import { hashMarketplaceReviewerPassword } from "../reviewer-access";
import { oauthClientConfigSha256 } from "../oauth-client-admission";
import {
  refreshOperatorCimdOAuthClient,
  registerOperatorOAuthClient,
  setOperatorOAuthClientEnabled,
} from "../operator-controls";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "https://client.example.test/metadata.json";
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
let pool: Pool | undefined;
let schema: string | undefined;
let transactionApplicationName: string | undefined;

function digest(value: number): Buffer {
  const result = Buffer.alloc(32);
  result.writeUInt32BE(value, 28);
  return result;
}

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function interactiveTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (transactionApplicationName) {
      await client.query("SELECT set_config('application_name', $1, true)", [
        transactionApplicationName,
      ]);
    }
    const result = await callback(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForAdvisoryLockWait(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool!.query(
      `SELECT 1
       FROM pg_stat_activity
       WHERE application_name = $1
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'`,
      [applicationName]
    );
    if (result.rowCount === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("consumer did not reach the cohort advisory-lock wait");
}

async function scalar(query: string, values: unknown[] = []): Promise<number> {
  const result = await pool!.query(query, values);
  return Number(result.rows[0]?.count ?? 0);
}

async function hostedProvisioningSnapshot(): Promise<Record<string, number>> {
  const result = await pool!.query(
    `SELECT
       (SELECT count(*) FROM users) AS users,
       (SELECT count(*) FROM exomem_tenants) AS tenants,
       (SELECT count(*) FROM exomem_entitlements) AS entitlements,
       (SELECT count(*) FROM exomem_capacity_allocations) AS capacity_allocations,
       (SELECT count(*) FROM exomem_capacity_claims) AS capacity_claims,
       (SELECT count(*) FROM exomem_lifecycle_operations) AS lifecycle_operations,
       (SELECT count(*) FROM exomem_cells) AS cells,
       (SELECT count(*) FROM exomem_cells WHERE provider_ref IS NOT NULL) AS cell_provider_refs,
       (SELECT count(*) FROM exomem_entitlements
        WHERE provider_customer_ref IS NOT NULL
           OR provider_subscription_ref IS NOT NULL
           OR provider_transaction_ref IS NOT NULL) AS entitlement_provider_refs,
       (SELECT count(*) FROM exomem_lifecycle_operations
        WHERE provider_result_ref IS NOT NULL) AS lifecycle_provider_refs,
       (SELECT count(*) FROM exomem_capacity_pools
        WHERE reserved_storage_bytes <> 0
           OR reserved_runtime_slots <> 0
           OR reserved_provision_slots <> 0) AS reserved_capacity_pools`
  );
  return Object.fromEntries(
    Object.entries(result.rows[0] as Record<string, string>).map(([key, value]) => [
      key,
      Number(value),
    ])
  );
}

function cimdMetadata(clientId: string, redirectUris: string[], label: string) {
  return {
    raw: JSON.stringify({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      label,
    }),
    document: {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none" as const,
    },
  };
}

async function seedClient(): Promise<string> {
  const result = await pool!.query(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       client_platform, oauth_client_config_sha256
     ) VALUES ($1, 'pinned', true, '["https://client.example.test/callback"]'::jsonb,
               digest(convert_to('["https://client.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
               'claude', $2)
     ON CONFLICT (client_id) DO UPDATE SET enabled = true
     RETURNING id`,
    [clientId, "f".repeat(64)]
  );
  return result.rows[0].id;
}

async function seedLiveCohort(): Promise<void> {
  const lock = (platform: "claude" | "openai", packageSha256: string, archiveSha256: string) => ({
    platform,
    artifact_sha256: packageSha256,
    archive_sha256: archiveSha256,
    compatibility_sha256: "c".repeat(64),
    schema_contract_sha256: "d".repeat(64),
    plugin_version: "1.0.0",
  });
  const claude = lock("claude", "a".repeat(64), "b".repeat(64));
  const openai = {
    ...lock("openai", "e".repeat(64), "f".repeat(64)),
    registered_app_id_sha256: "9".repeat(64),
  };
  const contract = await pool!.query(
    `INSERT INTO exomem_agent_contract_candidates (
       state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
       compatibility_digest, protocol_version, mcp_protocol_versions, contract, claude_package_lock, claude_archive_lock,
       openai_package_lock, openai_archive_lock, promoted_at
     ) VALUES (
       'live', 'hosted-alpha-agent-v1', $1, 'test', $2, $3, $4, '1', '["2025-11-25"]'::jsonb, '{}'::jsonb,
       $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, now()
     ) RETURNING id`,
    [
      resource,
      "1".repeat(64),
      "d".repeat(64),
      "c".repeat(64),
      JSON.stringify(claude),
      JSON.stringify(claude),
      JSON.stringify(openai),
      JSON.stringify(openai),
    ]
  );
  for (const candidate of [claude, openai]) {
    await pool!.query(
      `INSERT INTO exomem_client_artifacts (
         platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
         plugin_version, client_identity_sha256, paired_run_hmac_sha256,
         exomem_identity_hmac_sha256, tenant_hmac_sha256, install_url, evidence_sha256,
         result_sha256, contract_candidate_id, registered_app_id_sha256,
         oauth_client_config_sha256, observed_at, promoted_at
       ) VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                'https://example.test/install', $11, $12, $13::uuid, $14, $15, now(), now())`,
      [
        candidate.platform,
        candidate.artifact_sha256,
        candidate.archive_sha256,
        candidate.compatibility_sha256,
        candidate.schema_contract_sha256,
        candidate.plugin_version,
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        "4".repeat(64),
        "5".repeat(64),
        "6".repeat(64),
        candidate.platform === "openai" ? contract.rows[0].id : null,
        candidate.platform === "openai"
          ? (candidate as unknown as { registered_app_id_sha256: string }).registered_app_id_sha256
          : null,
        "f".repeat(64),
      ]
    );
  }
}

async function seedPool(storage = 10_737_418_240): Promise<void> {
  await pool!.query(
    `UPDATE exomem_capacity_pools
     SET storage_capacity_bytes = $1, runtime_capacity_slots = 2,
         provision_reservation_capacity = 2, provision_claim_capacity = 1,
         configured_at = now(), reserved_storage_bytes = 0,
         reserved_runtime_slots = 0, reserved_provision_slots = 0`,
    [storage]
  );
}

async function seedInviteAndTransaction(
  clientInternalId: string,
  suffix: string,
  marketplaceReviewerPurpose = false
): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, marketplace_reviewer_purpose, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, $3, $4, now() + interval '1 hour')`,
    [
      digest(Number(suffix)),
      `invite-${suffix}@example.test`,
      marketplaceReviewerPurpose,
      digest(90),
    ]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
     ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
       ARRAY['exomem.read', 'offline_access'], $4, '{}'::jsonb, $5, $6, 'challenge', now() + interval '1 hour')`,
    [digest(Number(suffix) + 20), clientInternalId, resource, digest(80), digest(81), digest(82)]
  );
}

async function seedAdmission(
  clientInternalId: string,
  sequence: number,
  email: string
): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, $3, now() + interval '1 hour')`,
    [digest(sequence), email, digest(sequence + 1)]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
     ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
       ARRAY['exomem.read'], $4, '{}'::jsonb, $5, $6, 'challenge', now() + interval '1 hour')`,
    [
      digest(sequence + 20),
      clientInternalId,
      resource,
      digest(sequence + 2),
      digest(sequence + 3),
      digest(sequence + 4),
    ]
  );
}

function admissionInput(sequence: number) {
  return {
    inviteDigest: digest(sequence),
    transactionDigest: digest(sequence + 20),
    sessionDigest: digest(sequence + 40),
    csrfDigest: digest(sequence + 60),
    sessionExpiresAt: new Date(Date.now() + 60_000),
    codeDigest: digest(sequence + 80),
    codeExpiresAt: new Date(Date.now() + 60_000),
  };
}

async function seedAuthorizationCode(
  clientInternalId: string,
  sequence: number,
  offlineAccess: boolean,
  marketplaceReviewerPurpose = false
) {
  const codeDigest = digest(sequence);
  const user = await pool!.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `oauth-${sequence}-${randomUUID()}@example.test`,
  ]);
  const tenant = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id, marketplace_reviewer_purpose) VALUES ($1, $2) RETURNING id",
    [user.rows[0].id, marketplaceReviewerPurpose]
  );
  await pool!.query(
    "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
    [tenant.rows[0].id]
  );
  const grant = await pool!.query(
    `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed)
     VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], $5) RETURNING id`,
    [user.rows[0].id, tenant.rows[0].id, clientInternalId, resource, offlineAccess]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_codes (
       code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at
     ) VALUES ($1, $2, $3, 'https://client.example.test/callback', $4, 'challenge', $5, now() + interval '1 hour')`,
    [codeDigest, grant.rows[0].id, clientInternalId, resource, offlineAccess]
  );
  return {
    codeDigest,
    grantId: grant.rows[0].id,
    userId: user.rows[0].id,
    tenantId: tenant.rows[0].id,
  };
}

async function seedBoundReviewerTenant(label: string): Promise<{
  userId: string;
  tenantId: string;
  cellId: string;
}> {
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`${label}-${randomUUID()}@example.test`]
  );
  const tenant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_tenants (
       owner_user_id, status, desired_state, marketplace_reviewer_purpose, legacy_unmetered
     ) VALUES ($1, 'active', 'running', true, true) RETURNING id`,
    [user.rows[0]!.id]
  );
  await pool!.query(
    `INSERT INTO exomem_entitlements (
       tenant_id, source, source_state, effective_state
     ) VALUES ($1, 'complimentary', 'active', 'active')`,
    [tenant.rows[0]!.id]
  );
  const cell = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_cells (
       tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
     ) VALUES ($1, 'active', 'bound', 'running', '1', 'shared-canary-base') RETURNING id`,
    [tenant.rows[0]!.id]
  );
  await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
    cell.rows[0]!.id,
    tenant.rows[0]!.id,
  ]);
  return {
    userId: user.rows[0]!.id,
    tenantId: tenant.rows[0]!.id,
    cellId: cell.rows[0]!.id,
  };
}

async function activateCanaryAssignment(input: {
  tenantId: string;
  priorCellId: string;
  assignmentId: string;
  assignmentGeneration: number;
}): Promise<void> {
  const target = await pool!.query<{
    candidate_id: string;
    source_release: string;
    protocol_version: string;
    gateway_contract_digest: string;
    command_fingerprint: string;
    schema_digest: string;
    compatibility_digest: string;
  }>(
    `SELECT candidate_id, source_release, protocol_version, gateway_contract_digest,
            command_fingerprint, schema_digest, compatibility_digest
     FROM exomem_agent_contract_rollout_assignments
     WHERE id = $1 AND tenant_id = $2 AND generation = $3`,
    [input.assignmentId, input.tenantId, input.assignmentGeneration]
  );
  assert.equal(target.rows.length, 1);
  const authority = target.rows[0]!;
  const replacement = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_cells (
       tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
       readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
       observed_schema_digest, observed_compatibility_digest
     ) VALUES ($1, 'provisioning', 'unbound', 'running', $2, $3, 'CELL_READY', $4, $5, $6, $7)
     RETURNING id`,
    [
      input.tenantId,
      authority.protocol_version,
      authority.source_release,
      authority.gateway_contract_digest,
      authority.command_fingerprint,
      authority.schema_digest,
      authority.compatibility_digest,
    ]
  );
  const operationId = randomUUID();
  await pool!.query(
    `INSERT INTO exomem_lifecycle_operations (
       id, tenant_id, cell_id, expected_previous_cell_id, operation_type, state, idempotency_key,
       fence_generation, checkpoint, lease_owner, lease_expires_at, provisioner_wire_protocol,
       target_candidate_id, target_assignment_id, target_assignment_generation,
       target_source_release, target_protocol_version, target_gateway_contract_digest,
       target_command_fingerprint, target_schema_digest, target_compatibility_digest
     ) SELECT $1, tenant.id, $2, $3, 'provision', 'running', $4,
              tenant.fence_generation, 'readiness-proved', 'shared-canary-bind', now() + interval '1 hour',
              'exomem-cell-provisioner.v2',
              $5, $6, $7, $8, $9, $10, $11, $12, $13
       FROM exomem_tenants AS tenant WHERE tenant.id = $14`,
    [
      operationId,
      replacement.rows[0]!.id,
      input.priorCellId,
      `shared-canary-${operationId}`,
      authority.candidate_id,
      input.assignmentId,
      input.assignmentGeneration,
      authority.source_release,
      authority.protocol_version,
      authority.gateway_contract_digest,
      authority.command_fingerprint,
      authority.schema_digest,
      authority.compatibility_digest,
      input.tenantId,
    ]
  );
  assert.equal(
    await new SqlLifecycleStore().bindCandidate(operationId, "shared-canary-bind"),
    true
  );
  const routes = await pool!.query<{
    cell_id: string;
    source_release: string;
    protocol_version: string;
    command_fingerprint: string;
    contract_digest: string;
    compatibility_digest: string;
  }>(
    `SELECT cell_id::text, source_release, protocol_version, command_fingerprint,
            contract_digest, compatibility_digest
     FROM exomem_routable_cell_contracts
     WHERE profile_id = 'hosted-alpha-agent-v1' AND routable = true
     ORDER BY cell_id`
  );
  const expectedRoutableSetDigest = createHash("sha256")
    .update(
      routes.rows
        .map((row) =>
          JSON.stringify([
            "hosted-alpha-agent-v1",
            row.cell_id,
            row.source_release,
            row.protocol_version,
            row.command_fingerprint,
            row.contract_digest,
            row.compatibility_digest,
          ])
        )
        .join(",")
    )
    .digest("hex");
  const promotionAuthority = await pool!.query<{
    routable_set_digest: string;
    routable_cell_count: number;
    source_release: string;
    protocol_version: string;
    command_fingerprint: string;
    contract_digest: string;
    compatibility_digest: string;
    fresh: boolean;
  }>(
    `SELECT routable_set_digest, routable_cell_count, source_release, protocol_version,
            command_fingerprint, contract_digest, compatibility_digest,
            observed_at > now() - interval '5 minutes' AS fresh
     FROM exomem_agent_contract_profile_authority
     WHERE profile_id = 'hosted-alpha-agent-v1'`
  );
  assert.deepEqual(promotionAuthority.rows, [
    {
      routable_set_digest: expectedRoutableSetDigest,
      routable_cell_count: routes.rows.length,
      source_release: authority.source_release,
      protocol_version: authority.protocol_version,
      command_fingerprint: authority.command_fingerprint,
      contract_digest: authority.schema_digest,
      compatibility_digest: authority.compatibility_digest,
      fresh: true,
    },
  ]);
}

function authorizationTransactionInput(input: {
  sequence: number;
  clientId: string;
  redirectUri: string;
}) {
  return {
    transactionDigest: digest(input.sequence),
    stateDigest: digest(input.sequence + 1),
    stateEnvelope: {
      version: 1 as const,
      algorithm: "A256GCM" as const,
      iv: "integration-iv",
      ciphertext: "integration-ciphertext",
      tag: "integration-tag",
    },
    formNonceDigest: digest(input.sequence + 2),
    continuationBinding: digest(input.sequence + 3),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource,
    scopes: ["exomem.read", "offline_access"],
    pkceChallenge: "shared-canary-challenge",
    expiresAt: new Date(Date.now() + 60 * 60_000),
  };
}

describe("OAuth admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `oauth_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.query(
      `ALTER TABLE "${schema}".exomem_lifecycle_operations
       DROP CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check`
    );
    await admin.query(
      `DROP TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable
       ON "${schema}".exomem_lifecycle_operations`
    );
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
    await seedLiveCohort();
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("leaves counters and rows unchanged for invalid invite or transaction", async () => {
    const internal = await seedClient();
    await seedPool();
    await seedInviteAndTransaction(internal, "1");
    const beforeCounters = await pool!.query(
      "SELECT reserved_storage_bytes, reserved_runtime_slots, reserved_provision_slots FROM exomem_capacity_pools"
    );
    const result = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(2),
      transactionDigest: digest(21),
      sessionDigest: digest(3),
      csrfDigest: digest(4),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      codeDigest: digest(5),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(result, null);
    const afterCounters = await pool!.query(
      "SELECT reserved_storage_bytes, reserved_runtime_slots, reserved_provision_slots FROM exomem_capacity_pools"
    );
    assert.deepEqual(afterCounters.rows, beforeCounters.rows);
    assert.equal(await scalar("SELECT count(*) FROM exomem_tenants"), 0);
    assert.equal(await scalar("SELECT count(*) FROM exomem_capacity_allocations"), 0);
  });

  it("attaches an existing owner without capacity or lifecycle mutation", async () => {
    const internal = await seedClient();
    const user = await pool!.query(
      "INSERT INTO users (email) VALUES ('owner@example.test') RETURNING id"
    );
    const tenant = await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
      [user.rows[0].id]
    );
    await pool!.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
      [tenant.rows[0].id]
    );
    const session = await pool!.query(
      "INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id",
      [user.rows[0].id, tenant.rows[0].id, digest(30), digest(31)]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
       ) VALUES ($1, $2, 'https://client.example.test/callback', $3, ARRAY['exomem.read'], $4,
         '{}'::jsonb, $5, $6, 'challenge', now() + interval '1 hour')`,
      [digest(32), internal, resource, digest(33), digest(35), digest(36)]
    );
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: session.rows[0].id,
      transactionDigest: digest(32),
      codeDigest: digest(34),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(attached?.tenantId, tenant.rows[0].id);
    assert.equal(await scalar("SELECT count(*) FROM exomem_capacity_allocations"), 0);
    assert.equal(await scalar("SELECT count(*) FROM exomem_lifecycle_operations"), 0);
  });

  it("rolls back v2 legacy invitation redemption without a catalog target", async () => {
    await createInviteRecord({
      tokenDigest: digest(400),
      emailNormalized: "legacy-v2-missing-target@example.test",
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: false,
      operatorPrincipalDigest: digest(401),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const counts = () =>
      Promise.all([
        scalar("SELECT count(*) FROM users"),
        scalar("SELECT count(*) FROM exomem_tenants"),
        scalar("SELECT count(*) FROM exomem_entitlements"),
        scalar("SELECT count(*) FROM exomem_sessions"),
        scalar("SELECT count(*) FROM exomem_lifecycle_operations"),
      ]);
    const before = await counts();
    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      await assert.rejects(
        redeemInviteAtomic({
          tokenDigest: digest(400),
          sessionDigest: digest(402),
          csrfDigest: digest(403),
          sessionExpiresAt: new Date(Date.now() + 60_000),
        })
      );
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
    assert.deepEqual(await counts(), before);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_invites WHERE token_digest = $1 AND consumed_at IS NULL",
        [digest(400)]
      ),
      1
    );
    assert.ok(
      await redeemInviteAtomic({
        tokenDigest: digest(400),
        sessionDigest: digest(404),
        csrfDigest: digest(405),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      })
    );
  });

  it("keeps invitation and tenant purpose immutable while legacy redemption supports ordinary and reviewer tenants", async () => {
    const ordinaryInvite = await createInviteRecord({
      tokenDigest: digest(50),
      emailNormalized: "ordinary-legacy@example.test",
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: false,
      operatorPrincipalDigest: digest(51),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const reviewerInvite = await createInviteRecord({
      tokenDigest: digest(52),
      emailNormalized: "reviewer-legacy@example.test",
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: true,
      operatorPrincipalDigest: digest(53),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const candidate = await pool!.query<{
      source_release: string;
      protocol_version: string;
      command_fingerprint: string;
      schema_digest: string;
      compatibility_digest: string;
    }>(
      `SELECT source_release, protocol_version, command_fingerprint, schema_digest,
              compatibility_digest
         FROM exomem_agent_contract_candidates
        WHERE profile_id = 'hosted-alpha-agent-v1' AND state = 'live'`
    );
    const catalogUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('legacy-catalog@example.test') RETURNING id"
    );
    const catalogTenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
      [catalogUser.rows[0]!.id]
    );
    const catalogCell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        catalogTenant.rows[0]!.id,
        candidate.rows[0]!.protocol_version,
        candidate.rows[0]!.source_release,
        "e".repeat(64),
        candidate.rows[0]!.command_fingerprint,
        candidate.rows[0]!.schema_digest,
        candidate.rows[0]!.compatibility_digest,
      ]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      catalogCell.rows[0]!.id,
      catalogTenant.rows[0]!.id,
    ]);

    const ordinary = await redeemInviteAtomic({
      tokenDigest: digest(50),
      sessionDigest: digest(54),
      csrfDigest: digest(55),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    const reviewer = await redeemInviteAtomic({
      tokenDigest: digest(52),
      sessionDigest: digest(56),
      csrfDigest: digest(57),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });

    assert.ok(ordinary);
    assert.ok(reviewer);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_tenants WHERE id = $1 AND marketplace_reviewer_purpose = false",
        [ordinary!.tenantId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_tenants WHERE id = $1 AND marketplace_reviewer_purpose = true",
        [reviewer!.tenantId]
      ),
      1
    );
    await assert.rejects(
      pool!.query("UPDATE exomem_invites SET marketplace_reviewer_purpose = true WHERE id = $1", [
        ordinaryInvite.inviteId,
      ]),
      /marketplace reviewer purpose is immutable/
    );
    await assert.rejects(
      pool!.query("UPDATE exomem_tenants SET marketplace_reviewer_purpose = false WHERE id = $1", [
        reviewer!.tenantId,
      ]),
      /marketplace reviewer purpose is immutable/
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_invites WHERE id = $1 AND marketplace_reviewer_purpose = false",
        [ordinaryInvite.inviteId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_tenants WHERE id = $1 AND marketplace_reviewer_purpose = true",
        [reviewer!.tenantId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_invites WHERE id = $1 AND consumed_at IS NOT NULL",
        [reviewerInvite.inviteId]
      ),
      1
    );
  });

  it("snapshots the catalog-backed v2 target for legacy invitation provisioning", async () => {
    const candidate = await pool!.query<{
      id: string;
      source_release: string;
      protocol_version: string;
      command_fingerprint: string;
      schema_digest: string;
      compatibility_digest: string;
    }>(
      `SELECT id, source_release, protocol_version, command_fingerprint, schema_digest,
              compatibility_digest
         FROM exomem_agent_contract_candidates
        WHERE profile_id = 'hosted-alpha-agent-v1' AND state = 'live'
        LIMIT 1`
    );
    const catalogUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('legacy-v2-catalog@example.test') RETURNING id"
    );
    const catalogTenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
      [catalogUser.rows[0]!.id]
    );
    const catalogCell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        catalogTenant.rows[0]!.id,
        candidate.rows[0]!.protocol_version,
        candidate.rows[0]!.source_release,
        "e".repeat(64),
        candidate.rows[0]!.command_fingerprint,
        candidate.rows[0]!.schema_digest,
        candidate.rows[0]!.compatibility_digest,
      ]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      catalogCell.rows[0]!.id,
      catalogTenant.rows[0]!.id,
    ]);
    await createInviteRecord({
      tokenDigest: digest(357),
      emailNormalized: "legacy-v2@example.test",
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: false,
      operatorPrincipalDigest: digest(358),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      const admitted = await redeemInviteAtomic({
        tokenDigest: digest(357),
        sessionDigest: digest(359),
        csrfDigest: digest(360),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      });
      assert.ok(admitted);
      const operation = await pool!.query<{
        provisioner_wire_protocol: string;
        target_candidate_id: string;
        target_gateway_contract_digest: string;
      }>(
        `SELECT provisioner_wire_protocol, target_candidate_id, target_gateway_contract_digest
           FROM exomem_lifecycle_operations
          WHERE id = $1`,
        [admitted.operationId]
      );
      assert.deepEqual(operation.rows, [
        {
          provisioner_wire_protocol: "exomem-cell-provisioner.v2",
          target_candidate_id: candidate.rows[0]!.id,
          target_gateway_contract_digest: "e".repeat(64),
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("snapshots the catalog-backed v2 target for OAuth invitation provisioning", async () => {
    const candidate = await pool!.query<{
      id: string;
      source_release: string;
      protocol_version: string;
      command_fingerprint: string;
      schema_digest: string;
      compatibility_digest: string;
    }>(
      `SELECT id, source_release, protocol_version, command_fingerprint, schema_digest,
              compatibility_digest
         FROM exomem_agent_contract_candidates
        WHERE profile_id = 'hosted-alpha-agent-v1' AND state = 'live'
        LIMIT 1`
    );
    const catalogUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('oauth-v2-catalog@example.test') RETURNING id"
    );
    const catalogTenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
      [catalogUser.rows[0]!.id]
    );
    const catalogCell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        catalogTenant.rows[0]!.id,
        candidate.rows[0]!.protocol_version,
        candidate.rows[0]!.source_release,
        "e".repeat(64),
        candidate.rows[0]!.command_fingerprint,
        candidate.rows[0]!.schema_digest,
        candidate.rows[0]!.compatibility_digest,
      ]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      catalogCell.rows[0]!.id,
      catalogTenant.rows[0]!.id,
    ]);
    const internal = await seedClient();
    await seedPool();
    await seedInviteAndTransaction(internal, "370");

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      const admitted = await admitFirstOAuthInviteAtomic({
        inviteDigest: digest(370),
        transactionDigest: digest(390),
        sessionDigest: digest(371),
        csrfDigest: digest(372),
        sessionExpiresAt: new Date(Date.now() + 60_000),
        codeDigest: digest(373),
        codeExpiresAt: new Date(Date.now() + 60_000),
      });
      assert.ok(admitted);
      const operation = await pool!.query<{
        provisioner_wire_protocol: string;
        target_candidate_id: string;
        target_gateway_contract_digest: string;
      }>(
        `SELECT provisioner_wire_protocol, target_candidate_id, target_gateway_contract_digest
           FROM exomem_lifecycle_operations
          WHERE id = $1`,
        [admitted.operationId]
      );
      assert.deepEqual(operation.rows, [
        {
          provisioner_wire_protocol: "exomem-cell-provisioner.v2",
          target_candidate_id: candidate.rows[0]!.id,
          target_gateway_contract_digest: "e".repeat(64),
        },
      ]);
      await pool!.query("DELETE FROM exomem_capacity_allocations WHERE tenant_id = $1", [
        admitted.tenantId,
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("propagates reviewer purpose through OAuth invite admission", async () => {
    const internal = await seedClient();
    await seedPool();
    await seedInviteAndTransaction(internal, "58", true);

    const admitted = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(58),
      transactionDigest: digest(78),
      sessionDigest: digest(59),
      csrfDigest: digest(60),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      codeDigest: digest(61),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });

    assert.ok(admitted);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_tenants WHERE id = $1 AND marketplace_reviewer_purpose = true",
        [admitted!.tenantId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_invites WHERE token_digest = $1 AND consumed_at IS NOT NULL",
        [digest(58)]
      ),
      1
    );
    await pool!.query("DELETE FROM exomem_capacity_allocations WHERE tenant_id = $1", [
      admitted!.tenantId,
    ]);
  });

  it("refuses ordinary reauthorization that would detach an existing reviewer grant", async () => {
    const internal = await seedClient();
    const user = await pool!.query(
      "INSERT INTO users (email) VALUES ('reviewer-reauthorization@example.test') RETURNING id"
    );
    const tenant = await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, marketplace_reviewer_purpose) VALUES ($1, true) RETURNING id",
      [user.rows[0].id]
    );
    await pool!.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
      [tenant.rows[0].id]
    );
    const reviewer = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         provider, username_digest, password_hash, owner_user_id, tenant_id,
         fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
       ) VALUES ('openai', $1, '$argon2id$integration', $2, $3,
                 'review-fixture-v1', $4, $5, now() + interval '1 hour')
       RETURNING id`,
      [digest(39), user.rows[0].id, tenant.rows[0].id, "b".repeat(64), digest(40)]
    );
    const grant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (
         user_id, tenant_id, client_id, resource, scopes, reviewer_credential_id
       ) VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], $5)
       RETURNING id`,
      [user.rows[0].id, tenant.rows[0].id, internal, resource, reviewer.rows[0]!.id]
    );
    const session = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
      [user.rows[0].id, tenant.rows[0].id, digest(41), digest(42)]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
       ) VALUES ($1, $2, 'https://client.example.test/callback', $3, ARRAY['exomem.read'], $4,
                 '{}'::jsonb, $5, $6, 'challenge', now() + interval '1 hour')`,
      [digest(43), internal, resource, digest(44), digest(45), digest(46)]
    );

    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: session.rows[0]!.id,
        transactionDigest: digest(43),
        codeDigest: digest(47),
        codeExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_grants WHERE id = $1 AND reviewer_credential_id = $2",
        [grant.rows[0]!.id, reviewer.rows[0]!.id]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1 AND consumed_at IS NULL",
        [digest(43)]
      ),
      1
    );
    await pool!.query(
      "UPDATE exomem_marketplace_reviewer_credentials SET revoked_at = now() WHERE id = $1",
      [reviewer.rows[0]!.id]
    );
  });

  it("seals temporary reviewer setup access before issuing a credential", async () => {
    const internal = await seedClient();
    await seedPool();
    await seedInviteAndTransaction(internal, "310", true);

    const admitted = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(310),
      transactionDigest: digest(330),
      sessionDigest: digest(311),
      csrfDigest: digest(312),
      sessionExpiresAt: new Date(Date.now() + 60_000),
      codeDigest: digest(313),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(admitted);

    const setupTokens = await issueOAuthTokensFromCodeAtomic({
      codeDigest: digest(313),
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(314),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(315),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(setupTokens);
    assert.ok(await findActiveOAuthAccessToken(digest(315)));

    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge,
         redeemed_session_id, expires_at
       ) VALUES ($1, $2, 'https://client.example.test/callback', $3, ARRAY['exomem.read'], $4,
                 '{}'::jsonb, $5, $6, 'challenge', $7, now() + interval '1 hour')`,
      [digest(316), internal, resource, digest(317), digest(318), digest(319), admitted!.sessionId]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_codes (
         code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, expires_at
       ) VALUES ($1, $2, $3, 'https://client.example.test/callback', $4, 'challenge',
                 now() + interval '1 hour')`,
      [digest(320), admitted!.grantId, internal, resource]
    );
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, protocol_version, release_version
       ) VALUES ($1, 'active', 'bound', '2025-11-25', 'setup-sealed') RETURNING id`,
      [admitted!.tenantId]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cell.rows[0]!.id,
      admitted!.tenantId,
    ]);
    const beforeSeal = await hostedProvisioningSnapshot();

    const credential = await createOrRotateMarketplaceReviewerCredentialAtomic({
      provider: "anthropic",
      usernameDigest: digest(321),
      passwordHash: await hashMarketplaceReviewerPassword("setup-reviewer-password"),
      ownerUserId: (
        await pool!.query<{ owner_user_id: string }>(
          "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
          [admitted!.tenantId]
        )
      ).rows[0]!.owner_user_id,
      tenantId: admitted!.tenantId,
      fixtureVersion: "review-fixture-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 5 * 60_000),
      operatorPrincipalDigest: digest(322),
    });
    assert.ok(credential);
    assert.deepEqual(await hostedProvisioningSnapshot(), beforeSeal);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_sessions WHERE id = $1 AND revoked_at IS NOT NULL",
        [admitted!.sessionId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1 AND consumed_at IS NOT NULL",
        [digest(316)]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_grants WHERE id = $1 AND revoked_at IS NOT NULL",
        [admitted!.grantId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_codes WHERE code_digest = $1 AND consumed_at IS NOT NULL",
        [digest(320)]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_token_families WHERE id = $1 AND revoked_at IS NOT NULL",
        [setupTokens!.familyId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_refresh_tokens WHERE refresh_digest = $1 AND consumed_at IS NOT NULL",
        [digest(314)]
      ),
      1
    );
    assert.equal(await findActiveOAuthAccessToken(digest(315)), null);
    assert.equal(await scalar("SELECT count(*) FROM exomem_oauth_account_blocks"), 0);
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_tenants WHERE id = $1 AND status <> 'deleted'", [
        admitted!.tenantId,
      ]),
      1
    );

    const ordinarySession = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
       SELECT owner_user_id, id, $1, $2, now() + interval '1 hour'
       FROM exomem_tenants WHERE id = $3 RETURNING id`,
      [digest(323), digest(324), admitted!.tenantId]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
       ) VALUES ($1, $2, 'https://client.example.test/callback', $3, ARRAY['exomem.read'], $4,
                 '{}'::jsonb, $5, $6, 'challenge', now() + interval '1 hour')`,
      [digest(325), internal, resource, digest(326), digest(327), digest(328)]
    );
    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: ordinarySession.rows[0]!.id,
        transactionDigest: digest(325),
        codeDigest: digest(329),
        codeExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );

    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
       ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
                 ARRAY['exomem.read', 'offline_access'], $4, '{}'::jsonb, $5, $6,
                 'challenge', now() + interval '1 hour')`,
      [digest(340), internal, resource, digest(341), digest(342), digest(343)]
    );
    const reviewerSession = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: credential!.credentialId,
      transactionDigest: digest(340),
      sessionDigest: digest(344),
      csrfDigest: digest(345),
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(reviewerSession);
    const reviewerGrant = await attachExistingOwnerAuthorizationAtomic({
      sessionId: reviewerSession!.sessionId,
      transactionDigest: digest(340),
      codeDigest: digest(346),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(reviewerGrant);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_grants WHERE id = $1 AND reviewer_credential_id = $2",
        [reviewerGrant!.grantId, credential!.credentialId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_codes WHERE code_digest = $1 AND grant_id = $2 AND consumed_at IS NULL",
        [digest(346), reviewerGrant!.grantId]
      ),
      1
    );
    assert.equal(
      await revokeMarketplaceReviewerCredentialAtomic({
        provider: "anthropic",
        operatorPrincipalDigest: digest(347),
      }),
      1
    );
    await pool!.query("DELETE FROM exomem_capacity_allocations WHERE tenant_id = $1", [
      admitted!.tenantId,
    ]);
  });

  it("serializes same-email admissions while reserving one final slot and leaves a losing invite reusable", async () => {
    const internal = await seedClient();
    await seedPool(EXOMEM_ALPHA_CAPACITY.storageBytes);
    await seedAdmission(internal, 200, "same-email@example.test");
    await seedAdmission(internal, 210, "same-email@example.test");
    const sameEmail = await Promise.all([
      admitFirstOAuthInviteAtomic(admissionInput(200)),
      admitFirstOAuthInviteAtomic(admissionInput(210)),
    ]);
    assert.equal(sameEmail.filter(Boolean).length, 2);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_tenants WHERE owner_user_id = (SELECT id FROM users WHERE email = 'same-email@example.test')"
      ),
      1
    );
    assert.equal(await scalar("SELECT count(*) FROM exomem_capacity_allocations"), 1);

    await seedAdmission(internal, 220, "losing-invite@example.test");
    await assert.rejects(
      admitFirstOAuthInviteAtomic(admissionInput(220)),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CAPACITY_UNAVAILABLE"
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_invites WHERE token_digest = $1 AND consumed_at IS NULL",
        [digest(220)]
      ),
      1
    );
  });

  it("persists the default v1 wire protocol for an initial provision operation", async () => {
    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    try {
      const internal = await seedClient();
      await seedPool();
      const candidate = await pool!.query<{
        source_release: string;
        protocol_version: string;
        command_fingerprint: string;
        schema_digest: string;
        compatibility_digest: string;
      }>(
        `SELECT source_release, protocol_version, command_fingerprint, schema_digest,
                compatibility_digest
           FROM exomem_agent_contract_candidates
          WHERE profile_id = 'hosted-alpha-agent-v1' AND state = 'live'
          LIMIT 1`
      );
      const catalogUser = await pool!.query<{ id: string }>(
        "INSERT INTO users (email) VALUES ('default-v1-catalog@example.test') RETURNING id"
      );
      const catalogTenant = await pool!.query<{ id: string }>(
        "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
        [catalogUser.rows[0]!.id]
      );
      const catalogCell = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_cells (
           tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
           observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
           observed_compatibility_digest
         ) VALUES ($1, 'active', 'bound', 'running', $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          catalogTenant.rows[0]!.id,
          candidate.rows[0]!.protocol_version,
          candidate.rows[0]!.source_release,
          "e".repeat(64),
          candidate.rows[0]!.command_fingerprint,
          candidate.rows[0]!.schema_digest,
          candidate.rows[0]!.compatibility_digest,
        ]
      );
      await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
        catalogCell.rows[0]!.id,
        catalogTenant.rows[0]!.id,
      ]);
      await seedInviteAndTransaction(internal, "590");
      const admitted = await admitFirstOAuthInviteAtomic({
        inviteDigest: digest(590),
        transactionDigest: digest(610),
        sessionDigest: digest(591),
        csrfDigest: digest(592),
        sessionExpiresAt: new Date(Date.now() + 60_000),
        codeDigest: digest(593),
        codeExpiresAt: new Date(Date.now() + 60_000),
      });

      assert.ok(admitted);
      const operation = await pool!.query<{
        provisioner_wire_protocol: string;
        target_candidate_id: string | null;
        target_assignment_id: string | null;
        target_assignment_generation: string | null;
        target_source_release: string | null;
        target_protocol_version: string | null;
        target_gateway_contract_digest: string | null;
        target_command_fingerprint: string | null;
        target_schema_digest: string | null;
        target_compatibility_digest: string | null;
      }>(
        `SELECT provisioner_wire_protocol, target_candidate_id, target_assignment_id,
                target_assignment_generation, target_source_release, target_protocol_version,
                target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
                target_compatibility_digest
           FROM exomem_lifecycle_operations
          WHERE tenant_id = $1`,
        [admitted!.tenantId]
      );
      assert.deepEqual(operation.rows, [
        {
          provisioner_wire_protocol: "exomem-cell-provisioner.v1",
          target_candidate_id: null,
          target_assignment_id: null,
          target_assignment_generation: null,
          target_source_release: null,
          target_protocol_version: null,
          target_gateway_contract_digest: null,
          target_command_fingerprint: null,
          target_schema_digest: null,
          target_compatibility_digest: null,
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("rejects a soft-deleted identity without changing capacity or consuming its invite", async () => {
    const internal = await seedClient();
    await seedPool();
    await pool!.query(
      "INSERT INTO users (email, deleted_at) VALUES ('deleted-owner@example.test', now())"
    );
    await seedAdmission(internal, 230, "deleted-owner@example.test");
    const allocationCountBeforeAdmission = await scalar(
      "SELECT count(*) FROM exomem_capacity_allocations"
    );
    assert.equal(await admitFirstOAuthInviteAtomic(admissionInput(230)), null);
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_capacity_allocations"),
      allocationCountBeforeAdmission
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_invites WHERE token_digest = $1 AND consumed_at IS NULL",
        [digest(230)]
      ),
      1
    );
  });

  it("does not consume a code when its resource binding is wrong", async () => {
    const internal = await seedClient();
    const fixture = await seedAuthorizationCode(internal, 110, true);
    const result = await issueOAuthTokensFromCodeAtomic({
      codeDigest: fixture.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource: `${resource}/wrong`,
      pkceChallenge: "challenge",
      refreshDigest: digest(111),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(112),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(result, null);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_codes WHERE code_digest = $1 AND consumed_at IS NULL",
        [fixture.codeDigest]
      ),
      1
    );
  });

  it("executes the MCP lookup against real coherent authority chains", async () => {
    const internal = await seedClient();
    const valid = await seedAuthorizationCode(internal, 160, false);
    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: valid.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(161),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(162),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(issued);
    assert.equal((await findMcpOAuthAccessToken(digest(162)))?.grantId, valid.grantId);

    const otherClient = await pool!.query(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
         client_platform, oauth_client_config_sha256
       ) VALUES ('https://other-client.example.test/metadata.json', 'pinned', true,
                 '["https://other-client.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://other-client.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                 'claude', $1)
       RETURNING id`,
      ["e".repeat(64)]
    );
    const mixedGrant = await pool!.query(
      `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
       VALUES ($1, $2, $3, $4, ARRAY['exomem.read']) RETURNING id`,
      [valid.userId, valid.tenantId, otherClient.rows[0].id, resource]
    );
    await pool!.query(
      `UPDATE exomem_oauth_token_families SET grant_id = $1, client_id = $2 WHERE id = $3`,
      [mixedGrant.rows[0].id, otherClient.rows[0].id, issued.familyId]
    );
    assert.equal(await findMcpOAuthAccessToken(digest(162)), null);

    const resourceMismatch = await seedAuthorizationCode(internal, 170, false);
    await issueOAuthTokensFromCodeAtomic({
      codeDigest: resourceMismatch.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(171),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(172),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    await pool!.query(
      `UPDATE exomem_oauth_access_tokens SET resource = $1 WHERE access_digest = $2`,
      [`${resource}/wrong`, digest(172)]
    );
    assert.equal(await findMcpOAuthAccessToken(digest(172)), null);

    const elevatedScope = await seedAuthorizationCode(internal, 180, false);
    await issueOAuthTokensFromCodeAtomic({
      codeDigest: elevatedScope.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(181),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(182),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    await pool!.query(
      `UPDATE exomem_oauth_access_tokens SET scopes = ARRAY['exomem.write'] WHERE access_digest = $1`,
      [digest(182)]
    );
    assert.equal(await findMcpOAuthAccessToken(digest(182)), null);
  });

  it("expires and revokes the complete attributed reviewer session and OAuth graph", async () => {
    const internal = await seedClient();
    const user = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ('reviewer-lifecycle@example.test') RETURNING id"
    );
    const tenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, marketplace_reviewer_purpose) VALUES ($1, true) RETURNING id",
      [user.rows[0]!.id]
    );
    await pool!.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
      [tenant.rows[0]!.id]
    );
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, protocol_version, release_version
       ) VALUES ($1, 'active', 'bound', '2025-11-25', 'integration') RETURNING id`,
      [tenant.rows[0]!.id]
    );
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cell.rows[0]!.id,
      tenant.rows[0]!.id,
    ]);

    const credentialExpiresAt = new Date(Date.now() + 5 * 60_000);
    const created = await createOrRotateMarketplaceReviewerCredentialAtomic({
      provider: "anthropic",
      usernameDigest: digest(260),
      passwordHash: await hashMarketplaceReviewerPassword("reviewer-password"),
      ownerUserId: user.rows[0]!.id,
      tenantId: tenant.rows[0]!.id,
      fixtureVersion: "review-fixture-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: credentialExpiresAt,
      operatorPrincipalDigest: digest(261),
    });
    assert.ok(created);
    const reviewerId = created!.credentialId;
    const lookup = await findMarketplaceReviewerCredentialForAuthentication(digest(260));
    assert.equal(lookup?.credentialId, reviewerId);
    assert.equal(lookup?.expiresAt, credentialExpiresAt.toISOString());
    const status = await getMarketplaceReviewerCredentialStatus("anthropic");
    assert.equal(status?.expiresAt, credentialExpiresAt.toISOString());

    async function reviewerSessionFor(sequence: number) {
      await pool!.query(
        `INSERT INTO exomem_oauth_authorization_transactions (
           transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
           state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
         ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
                   ARRAY['exomem.read', 'offline_access'], $4, '{}'::jsonb, $5, $6,
                   'challenge', now() + interval '1 hour')`,
        [
          digest(sequence),
          internal,
          resource,
          digest(sequence + 1),
          digest(sequence + 2),
          digest(sequence + 3),
        ]
      );
      return createMarketplaceReviewerOAuthSessionAtomic({
        credentialId: reviewerId,
        transactionDigest: digest(sequence),
        sessionDigest: digest(sequence + 4),
        csrfDigest: digest(sequence + 5),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }

    const reviewerSession = await reviewerSessionFor(262);
    assert.ok(reviewerSession);
    assert.equal((await findExomemSessionByDigest(digest(266)))?.tenantId, tenant.rows[0]!.id);
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: reviewerSession!.sessionId,
      transactionDigest: digest(262),
      codeDigest: digest(267),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(attached?.tenantId, tenant.rows[0]!.id);

    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: digest(267),
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(268),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(269),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(issued);
    assert.ok(await findActiveOAuthAccessToken(digest(269)));
    assert.ok(await findMcpOAuthAccessToken(digest(269)));
    assert.equal(
      await scalar(
        `SELECT count(*)
         FROM exomem_oauth_token_families AS family
         JOIN exomem_marketplace_reviewer_credentials AS credential ON credential.id = $2
         WHERE family.id = $1 AND family.expires_at <= credential.expires_at`,
        [issued!.familyId, reviewerId]
      ),
      1
    );
    assert.ok(
      await rotateOAuthRefreshTokenAtomic({
        refreshDigest: digest(268),
        replacementRefreshDigest: digest(270),
        accessDigest: digest(271),
        accessExpiresAt: new Date(Date.now() + 60_000),
        clientId,
        resource,
      })
    );

    const pendingSession = await reviewerSessionFor(272);
    assert.ok(pendingSession);
    const unusedCodeSession = await reviewerSessionFor(278);
    assert.ok(unusedCodeSession);
    assert.ok(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: unusedCodeSession!.sessionId,
        transactionDigest: digest(278),
        codeDigest: digest(283),
        codeExpiresAt: new Date(Date.now() + 60_000),
      })
    );

    await pool!.query(
      `UPDATE exomem_marketplace_reviewer_credentials
       SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [reviewerId]
    );
    assert.equal(await findExomemSessionByDigest(digest(266)), null);
    assert.equal(await findActiveOAuthAccessToken(digest(269)), null);
    assert.equal(await findMcpOAuthAccessToken(digest(269)), null);
    assert.equal(
      await rotateOAuthRefreshTokenAtomic({
        refreshDigest: digest(270),
        replacementRefreshDigest: digest(284),
        accessDigest: digest(285),
        accessExpiresAt: new Date(Date.now() + 60_000),
        clientId,
        resource,
      }),
      null
    );

    assert.equal(
      await revokeMarketplaceReviewerCredentialAtomic({
        provider: "anthropic",
        operatorPrincipalDigest: digest(273),
      }),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_sessions WHERE reviewer_credential_id = $1 AND revoked_at IS NULL",
        [reviewerId]
      ),
      0
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_grants WHERE reviewer_credential_id = $1 AND revoked_at IS NULL",
        [reviewerId]
      ),
      0
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_token_families WHERE id = $1 AND revoked_at IS NULL",
        [issued!.familyId]
      ),
      0
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1 AND consumed_at IS NULL",
        [digest(272)]
      ),
      0
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_codes WHERE code_digest = $1 AND consumed_at IS NULL",
        [digest(283)]
      ),
      0
    );
    assert.equal(await scalar("SELECT count(*) FROM exomem_oauth_account_blocks"), 0);
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_tenants WHERE id = $1 AND status <> 'deleted'", [
        tenant.rows[0]!.id,
      ]),
      1
    );
    assert.equal(await findActiveOAuthAccessToken(digest(269)), null);
    assert.equal(await findMcpOAuthAccessToken(digest(269)), null);
  });

  it("fails authorization client resolution closed when its own platform's artifact no longer matches", async () => {
    await seedClient();
    assert.ok(await resolveApprovedOAuthClient(clientId));
    // Another platform's artifact is not this client's business. A Claude client is
    // admitted on the strength of the Claude artifact, so retiring the OpenAI one
    // must leave it admitted -- that coupling is what blocked Claude admission on
    // an OpenAI app registration.
    await pool!.query(
      "UPDATE exomem_client_artifacts SET state = 'retired', retired_at = now() WHERE platform = 'openai'"
    );
    assert.ok(await resolveApprovedOAuthClient(clientId));
    await pool!.query(
      "UPDATE exomem_client_artifacts SET state = 'live', retired_at = NULL WHERE platform = 'openai'"
    );
    // Its own platform's artifact is its business: demoting that still fails closed.
    await pool!.query(
      "UPDATE exomem_client_artifacts SET state = 'retired', retired_at = now() WHERE platform = 'claude'"
    );
    assert.equal(await resolveApprovedOAuthClient(clientId), null);
    await pool!.query(
      "UPDATE exomem_client_artifacts SET state = 'live', retired_at = NULL WHERE platform = 'claude'"
    );
  });

  it("admits only a client configuration bound to the matching promoted artifact", async () => {
    const admittedClientId = `https://bound-client.example.test/${randomUUID()}`;
    const redirectUri = "https://bound-client.example.test/callback";
    const configDigest = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId: admittedClientId,
      redirectUris: [redirectUri],
    });
    const artifact = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_client_artifacts WHERE platform = 'claude' AND state = 'live' LIMIT 1"
    );
    await pool!.query(
      "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
      [configDigest, artifact.rows[0]!.id]
    );
    const registered = await registerOperatorOAuthClient({
      admissionMode: "pinned",
      platform: "claude",
      artifactId: artifact.rows[0]!.id,
      clientId: admittedClientId,
      redirectUris: [redirectUri],
    });
    assert.equal(registered.enabled, false);
    assert.equal(
      await setOperatorOAuthClientEnabled({ clientRecordId: registered.id, enabled: true }),
      true
    );
    assert.ok(await resolveApprovedOAuthClient(admittedClientId));
    await pool!.query(
      "UPDATE exomem_oauth_clients SET oauth_client_config_sha256 = $1 WHERE id = $2",
      ["0".repeat(64), registered.id]
    );
    assert.equal(await resolveApprovedOAuthClient(admittedClientId), null);
    await pool!.query(
      "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
      ["f".repeat(64), artifact.rows[0]!.id]
    );
  });

  it("admits a shared staged client while keeping reviewer authorization lineage exact", async () => {
    const candidateId = await storeRetainedExomemAgentContractCandidate("0.35.0");
    const candidateClientId = `https://shared-canary.example.test/${randomUUID()}`;
    const redirectUri = "https://shared-canary.example.test/callback";
    const configDigest = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId: candidateClientId,
      redirectUris: [redirectUri],
    });
    const stage = await createStagedClientRelease({
      candidateId,
      platform: "claude",
      packageSha256: candidateFixture0350.packageLock.artifact_sha256,
      archiveSha256: candidateFixture0350.archiveLock.archive_sha256,
      compatibilitySha256: candidateFixture0350.compatibility.compatibility_sha256,
      contractSha256: candidateFixture0350.compatibility.schema_contract_sha256,
      pluginVersion: candidateFixture0350.packageLock.plugin_version,
      oauthClientConfigSha256: configDigest,
      registeredAppIdSha256: null,
      operatorPrincipalDigest: "9".repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const registered = await registerOperatorOAuthClient({
      admissionMode: "pinned",
      platform: "claude",
      stagedClientReleaseId: stage.id,
      clientId: candidateClientId,
      redirectUris: [redirectUri],
    });
    assert.equal(registered.enabled, false);

    const reviewerA = await seedBoundReviewerTenant("shared-canary-a");
    const reviewerB = await seedBoundReviewerTenant("shared-canary-b");
    const assignmentExpiresAt = new Date(Date.now() + 60 * 60_000);
    const assignmentA = await createCanaryAssignment({
      tenantId: reviewerA.tenantId,
      candidateId,
      expiresAt: assignmentExpiresAt,
      operatorPrincipalDigest: "a".repeat(64),
    });
    const discardedAssignmentB = await createCanaryAssignment({
      tenantId: reviewerB.tenantId,
      candidateId,
      expiresAt: assignmentExpiresAt,
      operatorPrincipalDigest: "b".repeat(64),
    });
    assert.equal(
      await failCanaryAssignment({
        assignmentId: discardedAssignmentB.id,
        expectedVersion: discardedAssignmentB.version,
      }),
      true
    );
    const assignmentB = await createCanaryAssignment({
      tenantId: reviewerB.tenantId,
      candidateId,
      expiresAt: assignmentExpiresAt,
      operatorPrincipalDigest: "c".repeat(64),
    });
    assert.notEqual(assignmentA.id, assignmentB.id);
    assert.notEqual(assignmentA.generation, assignmentB.generation);
    await activateCanaryAssignment({
      tenantId: reviewerA.tenantId,
      priorCellId: reviewerA.cellId,
      assignmentId: assignmentA.id,
      assignmentGeneration: assignmentA.generation,
    });
    await activateCanaryAssignment({
      tenantId: reviewerB.tenantId,
      priorCellId: reviewerB.cellId,
      assignmentId: assignmentB.id,
      assignmentGeneration: assignmentB.generation,
    });

    const credentialA = await createInternalCanaryReviewerCredentialAtomic({
      platform: "claude",
      usernameDigest: digest(400),
      passwordHash: "$argon2id$shared-canary-a",
      tenantId: reviewerA.tenantId,
      candidateId,
      assignmentId: assignmentA.id,
      assignmentGeneration: assignmentA.generation,
      stagedClientReleaseId: stage.id,
      oauthClientId: registered.id,
      fixtureVersion: "shared-canary-a",
      fixturePayloadDigest: "d".repeat(64),
      operatorPrincipalDigest: digest(401),
      expiresAt: new Date(Date.now() + 50 * 60_000),
    });
    const credentialB = await createInternalCanaryReviewerCredentialAtomic({
      platform: "claude",
      usernameDigest: digest(410),
      passwordHash: "$argon2id$shared-canary-b",
      tenantId: reviewerB.tenantId,
      candidateId,
      assignmentId: assignmentB.id,
      assignmentGeneration: assignmentB.generation,
      stagedClientReleaseId: stage.id,
      oauthClientId: registered.id,
      fixtureVersion: "shared-canary-b",
      fixturePayloadDigest: "e".repeat(64),
      operatorPrincipalDigest: digest(411),
      expiresAt: new Date(Date.now() + 50 * 60_000),
    });
    assert.ok(credentialA);
    assert.ok(credentialB);

    assert.equal(
      (await resolveApprovedOAuthClient(candidateClientId))?.clientId,
      candidateClientId
    );
    const transactionAInput = authorizationTransactionInput({
      sequence: 420,
      clientId: candidateClientId,
      redirectUri,
    });
    const transactionBInput = authorizationTransactionInput({
      sequence: 430,
      clientId: candidateClientId,
      redirectUri,
    });
    assert.ok(await createAuthorizationTransaction(transactionAInput));
    assert.ok(await createAuthorizationTransaction(transactionBInput));

    const sessionA = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: credentialA!.credentialId,
      transactionDigest: transactionAInput.transactionDigest,
      sessionDigest: digest(440),
      csrfDigest: digest(441),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    const sessionB = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: credentialB!.credentialId,
      transactionDigest: transactionBInput.transactionDigest,
      sessionDigest: digest(450),
      csrfDigest: digest(451),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    assert.ok(sessionA);
    assert.ok(sessionB);

    // Re-authenticating as YOURSELF on a transaction you already bound must work.
    // This returned null before 2026-08-16: the first success binds the transaction,
    // and the canary branch demanded an unbound one, so the retry was structurally
    // impossible and surfaced as "check the credentials". It cost a promotion window.
    const sessionARepeat = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: credentialA!.credentialId,
      transactionDigest: transactionAInput.transactionDigest,
      sessionDigest: digest(460),
      csrfDigest: digest(461),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    assert.ok(sessionARepeat, "re-authenticating the same credential must be idempotent");
    assert.notEqual(
      sessionARepeat!.sessionId,
      sessionA!.sessionId,
      "a repeat sign-in mints fresh session material rather than resurrecting the old one"
    );

    // The other half of the condition. Without this the assertion above would pass
    // even if the binding check had been removed outright rather than narrowed.
    const hijack = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: credentialB!.credentialId,
      transactionDigest: transactionAInput.transactionDigest,
      sessionDigest: digest(470),
      csrfDigest: digest(471),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    assert.equal(
      hijack,
      null,
      "a different credential must never bind a transaction already bound to another"
    );

    const bound = await pool!.query(
      `SELECT session.id AS session_id, session.tenant_id, session.reviewer_credential_id,
              session.candidate_id, session.assignment_id, session.assignment_generation::text,
              session.staged_client_release_id, session.oauth_client_id,
              transaction.reviewer_credential_id AS transaction_credential_id,
              transaction.candidate_id AS transaction_candidate_id,
              transaction.assignment_id AS transaction_assignment_id,
              transaction.assignment_generation::text AS transaction_assignment_generation,
              transaction.staged_client_release_id AS transaction_stage_id
       FROM exomem_sessions AS session
       JOIN exomem_oauth_authorization_transactions AS transaction
         ON transaction.reviewer_credential_id = session.reviewer_credential_id
       WHERE session.id IN ($1, $2) AND transaction.transaction_digest IN ($3, $4)
       ORDER BY session.id`,
      [
        sessionA!.sessionId,
        sessionB!.sessionId,
        transactionAInput.transactionDigest,
        transactionBInput.transactionDigest,
      ]
    );
    const expectedBound = [
      {
        sessionId: sessionA!.sessionId,
        reviewer: reviewerA,
        credential: credentialA!,
        assignment: assignmentA,
      },
      {
        sessionId: sessionB!.sessionId,
        reviewer: reviewerB,
        credential: credentialB!,
        assignment: assignmentB,
      },
    ]
      .map(({ sessionId, reviewer, credential, assignment }) => ({
        session_id: sessionId,
        tenant_id: reviewer.tenantId,
        reviewer_credential_id: credential.credentialId,
        candidate_id: candidateId,
        assignment_id: assignment.id,
        assignment_generation: String(assignment.generation),
        staged_client_release_id: stage.id,
        oauth_client_id: registered.id,
        transaction_credential_id: credential.credentialId,
        transaction_candidate_id: candidateId,
        transaction_assignment_id: assignment.id,
        transaction_assignment_generation: String(assignment.generation),
        transaction_stage_id: stage.id,
      }))
      .sort((left, right) => left.session_id.localeCompare(right.session_id));
    assert.deepEqual(bound.rows, expectedBound);

    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: sessionA!.sessionId,
        transactionDigest: transactionBInput.transactionDigest,
        codeDigest: digest(460),
        codeExpiresAt: new Date(Date.now() + 10 * 60_000),
      }),
      null
    );
    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: sessionB!.sessionId,
        transactionDigest: transactionAInput.transactionDigest,
        codeDigest: digest(461),
        codeExpiresAt: new Date(Date.now() + 10 * 60_000),
      }),
      null
    );
    assert.equal(
      await scalar(
        `SELECT count(*) FROM exomem_oauth_grants AS grant_row
         JOIN exomem_oauth_authorization_transactions AS transaction
           ON transaction.id = grant_row.authorization_transaction_id
         WHERE transaction.transaction_digest IN ($1, $2)`,
        [transactionAInput.transactionDigest, transactionBInput.transactionDigest]
      ),
      0
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_authorization_codes WHERE code_digest IN ($1, $2)",
        [digest(460), digest(461)]
      ),
      0
    );

    const completedA = await attachExistingOwnerAuthorizationAtomic({
      sessionId: sessionA!.sessionId,
      transactionDigest: transactionAInput.transactionDigest,
      codeDigest: digest(462),
      codeExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const completedB = await attachExistingOwnerAuthorizationAtomic({
      sessionId: sessionB!.sessionId,
      transactionDigest: transactionBInput.transactionDigest,
      codeDigest: digest(463),
      codeExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.equal(completedA?.tenantId, reviewerA.tenantId);
    assert.equal(completedB?.tenantId, reviewerB.tenantId);

    const completed = await pool!.query(
      `SELECT grant_row.id AS grant_id, grant_row.tenant_id, grant_row.reviewer_credential_id,
              grant_row.candidate_id, grant_row.assignment_id,
              grant_row.assignment_generation::text, grant_row.staged_client_release_id,
              code.reviewer_credential_id AS code_credential_id,
              code.candidate_id AS code_candidate_id, code.assignment_id AS code_assignment_id,
              code.assignment_generation::text AS code_assignment_generation,
              code.staged_client_release_id AS code_stage_id
       FROM exomem_oauth_grants AS grant_row
       JOIN exomem_oauth_authorization_codes AS code ON code.grant_id = grant_row.id
       WHERE grant_row.id IN ($1, $2) AND code.code_digest IN ($3, $4)
       ORDER BY grant_row.id`,
      [completedA!.grantId, completedB!.grantId, digest(462), digest(463)]
    );
    const expectedCompleted = [
      {
        grantId: completedA!.grantId,
        reviewer: reviewerA,
        credential: credentialA!,
        assignment: assignmentA,
      },
      {
        grantId: completedB!.grantId,
        reviewer: reviewerB,
        credential: credentialB!,
        assignment: assignmentB,
      },
    ]
      .map(({ grantId, reviewer, credential, assignment }) => ({
        grant_id: grantId,
        tenant_id: reviewer.tenantId,
        reviewer_credential_id: credential.credentialId,
        candidate_id: candidateId,
        assignment_id: assignment.id,
        assignment_generation: String(assignment.generation),
        staged_client_release_id: stage.id,
        code_credential_id: credential.credentialId,
        code_candidate_id: candidateId,
        code_assignment_id: assignment.id,
        code_assignment_generation: String(assignment.generation),
        code_stage_id: stage.id,
      }))
      .sort((left, right) => left.grant_id.localeCompare(right.grant_id));
    assert.deepEqual(completed.rows, expectedCompleted);

    const descendantStates = async () =>
      (
        await pool!.query(
          `SELECT session.tenant_id, session.reviewer_credential_id, session.candidate_id,
                  session.assignment_id, session.assignment_generation::text,
                  session.staged_client_release_id, session.oauth_client_id,
                  session.revoked_at IS NOT NULL AS session_revoked,
                  transaction.consumed_at IS NOT NULL AS transaction_consumed,
                  grant_row.revoked_at IS NOT NULL AS grant_revoked,
                  code.consumed_at IS NOT NULL AS code_consumed,
                  ROW(transaction.reviewer_credential_id, transaction.candidate_id,
                      transaction.assignment_id, transaction.assignment_generation,
                      transaction.staged_client_release_id, transaction.client_id)
                    IS NOT DISTINCT FROM
                  ROW(session.reviewer_credential_id, session.candidate_id,
                      session.assignment_id, session.assignment_generation,
                      session.staged_client_release_id, session.oauth_client_id) AS transaction_bound,
                  ROW(grant_row.reviewer_credential_id, grant_row.candidate_id,
                      grant_row.assignment_id, grant_row.assignment_generation,
                      grant_row.staged_client_release_id, grant_row.client_id)
                    IS NOT DISTINCT FROM
                  ROW(session.reviewer_credential_id, session.candidate_id,
                      session.assignment_id, session.assignment_generation,
                      session.staged_client_release_id, session.oauth_client_id) AS grant_bound,
                  ROW(code.reviewer_credential_id, code.candidate_id,
                      code.assignment_id, code.assignment_generation,
                      code.staged_client_release_id, code.client_id)
                    IS NOT DISTINCT FROM
                  ROW(session.reviewer_credential_id, session.candidate_id,
                      session.assignment_id, session.assignment_generation,
                      session.staged_client_release_id, session.oauth_client_id) AS code_bound
           FROM exomem_sessions AS session
           JOIN exomem_oauth_authorization_transactions AS transaction
             ON transaction.redeemed_session_id = session.id
           JOIN exomem_oauth_grants AS grant_row
             ON grant_row.authorization_transaction_id = transaction.id
           JOIN exomem_oauth_authorization_codes AS code ON code.grant_id = grant_row.id
           WHERE session.id IN ($1, $2) AND grant_row.id IN ($3, $4)
           ORDER BY session.tenant_id`,
          [sessionA!.sessionId, sessionB!.sessionId, completedA!.grantId, completedB!.grantId]
        )
      ).rows;
    const expectedDescendantState = (
      reviewer: typeof reviewerA,
      credential: NonNullable<typeof credentialA>,
      assignment: typeof assignmentA,
      revoked: boolean
    ) => ({
      tenant_id: reviewer.tenantId,
      reviewer_credential_id: credential.credentialId,
      candidate_id: candidateId,
      assignment_id: assignment.id,
      assignment_generation: String(assignment.generation),
      staged_client_release_id: stage.id,
      oauth_client_id: registered.id,
      session_revoked: revoked,
      transaction_consumed: true,
      grant_revoked: revoked,
      code_consumed: revoked,
      transaction_bound: true,
      grant_bound: true,
      code_bound: true,
    });

    await pool!.query(
      "UPDATE exomem_agent_contract_rollout_assignments SET expires_at = activated_at + interval '1 microsecond' WHERE id = $1",
      [assignmentA.id]
    );
    const firstExpiry = await expireCanaryAuthority();
    assert.equal(firstExpiry.expiredAssignments, 1);
    assert.deepEqual(
      await descendantStates(),
      [
        expectedDescendantState(reviewerA, credentialA!, assignmentA, true),
        expectedDescendantState(reviewerB, credentialB!, assignmentB, false),
      ].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id))
    );
    assert.equal(
      (await resolveApprovedOAuthClient(candidateClientId))?.clientId,
      candidateClientId
    );
    assert.ok(
      await createAuthorizationTransaction(
        authorizationTransactionInput({
          sequence: 470,
          clientId: candidateClientId,
          redirectUri,
        })
      )
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT id, revoked_at IS NOT NULL AS revoked
           FROM exomem_marketplace_reviewer_credentials
           WHERE id IN ($1, $2) ORDER BY id`,
          [credentialA!.credentialId, credentialB!.credentialId]
        )
      ).rows.map((row) => ({ id: row.id, revoked: row.revoked })),
      [
        { id: credentialA!.credentialId, revoked: true },
        { id: credentialB!.credentialId, revoked: false },
      ].sort((left, right) => left.id.localeCompare(right.id))
    );

    await pool!.query(
      "UPDATE exomem_agent_contract_rollout_assignments SET expires_at = activated_at + interval '1 microsecond' WHERE id = $1",
      [assignmentB.id]
    );
    const secondExpiry = await expireCanaryAuthority();
    assert.equal(secondExpiry.expiredAssignments, 1);
    assert.deepEqual(
      await descendantStates(),
      [
        expectedDescendantState(reviewerA, credentialA!, assignmentA, true),
        expectedDescendantState(reviewerB, credentialB!, assignmentB, true),
      ].sort((left, right) => left.tenant_id.localeCompare(right.tenant_id))
    );
    assert.equal(await resolveApprovedOAuthClient(candidateClientId), null);
    assert.equal(
      await createAuthorizationTransaction(
        authorizationTransactionInput({
          sequence: 480,
          clientId: candidateClientId,
          redirectUri,
        })
      ),
      null
    );
  });

  it("keeps the 32-client admission bound under concurrent registration and permits an existing client at capacity", async () => {
    const artifact = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_client_artifacts WHERE platform = 'claude' AND state = 'live' LIMIT 1"
    );
    const existingClientId = `https://oauth-capacity-existing.example.test/${randomUUID()}`;
    const existingRedirectUri = "https://oauth-capacity-existing.example.test/callback";
    const existingConfig = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId: existingClientId,
      redirectUris: [existingRedirectUri],
    });
    const newClients = ["one", "two"].map((suffix) => {
      const clientId = `https://oauth-capacity-new-${suffix}.example.test/${randomUUID()}`;
      const redirectUri = `https://oauth-capacity-new-${suffix}.example.test/callback`;
      return {
        clientId,
        redirectUri,
        config: oauthClientConfigSha256({
          platform: "claude",
          admissionMode: "pinned",
          clientId,
          redirectUris: [redirectUri],
        }),
      };
    });
    const pendingArtifactIds: string[] = [];

    await pool!.query(
      "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
      [existingConfig, artifact.rows[0]!.id]
    );
    try {
      const registered = await registerOperatorOAuthClient({
        admissionMode: "pinned",
        platform: "claude",
        artifactId: artifact.rows[0]!.id,
        clientId: existingClientId,
        redirectUris: [existingRedirectUri],
      });
      assert.equal(
        await setOperatorOAuthClientEnabled({ clientRecordId: registered.id, enabled: true }),
        true
      );

      const currentCount = await scalar("SELECT count(*) FROM exomem_oauth_clients");
      assert.ok(currentCount <= 32);
      for (let index = currentCount; index < 31; index += 1) {
        const fillerClientId = `https://oauth-capacity-filler.example.test/${randomUUID()}`;
        const fillerRedirectUri = "https://oauth-capacity-filler.example.test/callback";
        await pool!.query(
          `INSERT INTO exomem_oauth_clients (
             client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
             client_platform, oauth_client_config_sha256
           ) VALUES ($1, 'pinned', false, $2::jsonb,
                     digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'),
                     'claude', $3)`,
          [
            fillerClientId,
            JSON.stringify([fillerRedirectUri]),
            oauthClientConfigSha256({
              platform: "claude",
              admissionMode: "pinned",
              clientId: fillerClientId,
              redirectUris: [fillerRedirectUri],
            }),
          ]
        );
      }
      assert.equal(await scalar("SELECT count(*) FROM exomem_oauth_clients"), 31);

      for (const client of newClients) {
        const pending = await pool!.query<{ id: string }>(
          `INSERT INTO exomem_client_artifacts (
             platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
             plugin_version, client_identity_sha256, paired_run_hmac_sha256,
             exomem_identity_hmac_sha256, tenant_hmac_sha256, install_url, evidence_sha256,
             result_sha256, oauth_client_config_sha256, observed_at
           ) SELECT platform, 'pending', package_sha256, archive_sha256, compatibility_sha256,
                    contract_sha256, plugin_version, client_identity_sha256, paired_run_hmac_sha256,
                    exomem_identity_hmac_sha256, tenant_hmac_sha256, install_url, evidence_sha256,
                    result_sha256, $1, now()
             FROM exomem_client_artifacts WHERE id = $2
             RETURNING id`,
          [client.config, artifact.rows[0]!.id]
        );
        pendingArtifactIds.push(pending.rows[0]!.id);
      }
      const attempts = await Promise.allSettled(
        newClients.map((client, index) =>
          registerOperatorOAuthClient({
            admissionMode: "pinned",
            platform: "claude",
            artifactId: pendingArtifactIds[index],
            clientId: client.clientId,
            redirectUris: [client.redirectUri],
          })
        )
      );
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      assert.ok(
        rejected &&
          rejected.reason instanceof ExomemHostedError &&
          rejected.reason.code === "INVALID_REQUEST"
      );
      assert.equal(await scalar("SELECT count(*) FROM exomem_oauth_clients"), 32);

      const idempotent = await registerOperatorOAuthClient({
        admissionMode: "pinned",
        platform: "claude",
        artifactId: artifact.rows[0]!.id,
        clientId: existingClientId,
        redirectUris: [existingRedirectUri],
      });
      assert.deepEqual(idempotent, { id: registered.id, enabled: true });
    } finally {
      await pool!.query(
        "DELETE FROM exomem_oauth_clients WHERE client_id LIKE 'https://oauth-capacity-%'"
      );
      if (pendingArtifactIds.length > 0) {
        await pool!.query("DELETE FROM exomem_client_artifacts WHERE id = ANY($1::uuid[])", [
          pendingArtifactIds,
        ]);
      }
      await pool!.query(
        "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
        ["f".repeat(64), artifact.rows[0]!.id]
      );
    }
  });

  it("does not let a slow CIMD refresh overwrite a newer disabled cache authority", async () => {
    const artifact = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_client_artifacts WHERE platform = 'claude' AND state = 'live' LIMIT 1"
    );
    const cimdClientId = `https://cimd-client.example.test/${randomUUID()}`;
    const redirectUris = ["https://cimd-client.example.test/callback"];
    const config = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "cimd",
      clientId: cimdClientId,
      redirectUris,
    });
    const originalAllowedHosts = process.env.EXOMEM_CIMD_ALLOWED_HOSTS;
    process.env.EXOMEM_CIMD_ALLOWED_HOSTS = "cimd-client.example.test";
    await pool!.query(
      "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
      [config, artifact.rows[0]!.id]
    );
    try {
      const registered = await registerOperatorOAuthClient(
        {
          admissionMode: "cimd",
          platform: "claude",
          artifactId: artifact.rows[0]!.id,
          clientId: cimdClientId,
          redirectUris,
        },
        { fetchCimd: async () => cimdMetadata(cimdClientId, redirectUris, "initial") }
      );
      assert.equal(
        await setOperatorOAuthClientEnabled({ clientRecordId: registered.id, enabled: true }),
        true
      );

      let releaseSlowFetch: (() => void) | undefined;
      let signalSlowFetch: (() => void) | undefined;
      const slowFetchStarted = new Promise<void>((resolve) => {
        signalSlowFetch = resolve;
      });
      const slowRefresh = refreshOperatorCimdOAuthClient(registered.id, {
        fetchCimd: async () => {
          signalSlowFetch!();
          await new Promise<void>((resolve) => {
            releaseSlowFetch = resolve;
          });
          return cimdMetadata(cimdClientId, redirectUris, "stale");
        },
      });
      await slowFetchStarted;

      assert.equal(
        await setOperatorOAuthClientEnabled({ clientRecordId: registered.id, enabled: false }),
        true
      );
      await registerOperatorOAuthClient(
        {
          admissionMode: "cimd",
          platform: "claude",
          artifactId: artifact.rows[0]!.id,
          clientId: cimdClientId,
          redirectUris,
        },
        { fetchCimd: async () => cimdMetadata(cimdClientId, redirectUris, "newer") }
      );
      const newer = await pool!.query(
        `SELECT enabled, authority_version::text, encode(metadata_document_digest, 'hex') AS metadata_digest,
                redirect_uris::text, metadata_provenance::text
         FROM exomem_oauth_clients WHERE id = $1`,
        [registered.id]
      );
      releaseSlowFetch!();
      await assert.rejects(
        slowRefresh,
        (error: unknown) => error instanceof ExomemHostedError && error.code === "INVALID_REQUEST"
      );
      const afterConflict = await pool!.query(
        `SELECT enabled, authority_version::text, encode(metadata_document_digest, 'hex') AS metadata_digest,
                redirect_uris::text, metadata_provenance::text
         FROM exomem_oauth_clients WHERE id = $1`,
        [registered.id]
      );
      assert.equal(newer.rows[0].enabled, false);
      assert.deepEqual(afterConflict.rows, newer.rows);
    } finally {
      if (originalAllowedHosts === undefined) delete process.env.EXOMEM_CIMD_ALLOWED_HOSTS;
      else process.env.EXOMEM_CIMD_ALLOWED_HOSTS = originalAllowedHosts;
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [cimdClientId]);
      await pool!.query(
        "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
        ["f".repeat(64), artifact.rows[0]!.id]
      );
    }
  });

  it("keeps registration and CIMD refresh out of hosted provisioning and provider state", async () => {
    const artifact = await pool!.query<{ id: string }>(
      "SELECT id FROM exomem_client_artifacts WHERE platform = 'claude' AND state = 'live' LIMIT 1"
    );
    const pinnedClientId = `https://oauth-state-pinned.example.test/${randomUUID()}`;
    const pinnedRedirectUri = "https://oauth-state-pinned.example.test/callback";
    const pinnedConfig = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId: pinnedClientId,
      redirectUris: [pinnedRedirectUri],
    });
    const cimdClientId = `https://oauth-state-cimd.example.test/${randomUUID()}`;
    const cimdRedirectUris = ["https://oauth-state-cimd.example.test/callback"];
    const cimdConfig = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "cimd",
      clientId: cimdClientId,
      redirectUris: cimdRedirectUris,
    });
    const originalAllowedHosts = process.env.EXOMEM_CIMD_ALLOWED_HOSTS;
    process.env.EXOMEM_CIMD_ALLOWED_HOSTS = "oauth-state-cimd.example.test";
    try {
      await pool!.query(
        "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
        [pinnedConfig, artifact.rows[0]!.id]
      );
      const beforePinned = await hostedProvisioningSnapshot();
      await registerOperatorOAuthClient({
        admissionMode: "pinned",
        platform: "claude",
        artifactId: artifact.rows[0]!.id,
        clientId: pinnedClientId,
        redirectUris: [pinnedRedirectUri],
      });
      assert.deepEqual(await hostedProvisioningSnapshot(), beforePinned);

      await pool!.query(
        "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
        [cimdConfig, artifact.rows[0]!.id]
      );
      const beforeCimdRegistration = await hostedProvisioningSnapshot();
      const cimd = await registerOperatorOAuthClient(
        {
          admissionMode: "cimd",
          platform: "claude",
          artifactId: artifact.rows[0]!.id,
          clientId: cimdClientId,
          redirectUris: cimdRedirectUris,
        },
        { fetchCimd: async () => cimdMetadata(cimdClientId, cimdRedirectUris, "registered") }
      );
      assert.deepEqual(await hostedProvisioningSnapshot(), beforeCimdRegistration);

      const beforeRefresh = await hostedProvisioningSnapshot();
      await refreshOperatorCimdOAuthClient(cimd.id, {
        fetchCimd: async () => cimdMetadata(cimdClientId, cimdRedirectUris, "refreshed"),
      });
      assert.deepEqual(await hostedProvisioningSnapshot(), beforeRefresh);
    } finally {
      if (originalAllowedHosts === undefined) delete process.env.EXOMEM_CIMD_ALLOWED_HOSTS;
      else process.env.EXOMEM_CIMD_ALLOWED_HOSTS = originalAllowedHosts;
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id IN ($1, $2)", [
        pinnedClientId,
        cimdClientId,
      ]);
      await pool!.query(
        "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
        ["f".repeat(64), artifact.rows[0]!.id]
      );
    }
  });

  it("waits for artifact demotion before taking the cohort authorization snapshot", async () => {
    await seedClient();
    const lock = await pool!.connect();
    const applicationName = `exomem-oauth-cohort-${randomUUID()}`;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      await lock.query(
        "UPDATE exomem_client_artifacts SET state = 'retired', retired_at = now() WHERE platform = 'claude'"
      );
      transactionApplicationName = applicationName;
      let settled = false;
      const resolution = resolveApprovedOAuthClient(clientId).then((result) => {
        settled = true;
        return result;
      });
      await waitForAdvisoryLockWait(applicationName);
      assert.equal(settled, false);
      await lock.query("COMMIT");
      assert.equal(await resolution, null);
    } finally {
      transactionApplicationName = undefined;
      await lock.query("ROLLBACK").catch(() => undefined);
      lock.release();
      await pool!.query(
        "UPDATE exomem_client_artifacts SET state = 'live', retired_at = NULL WHERE platform = 'claude'"
      );
    }
  });

  it("blocks an authoritative account and revokes every usable OAuth credential atomically", async () => {
    const internal = await seedClient();
    const fixture = await seedAuthorizationCode(internal, 140, true);
    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: fixture.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(141),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(142),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(issued);
    assert.equal(
      await revokeOAuthAccountForOwnerTenantAtomic({
        ownerUserId: fixture.userId,
        tenantId: fixture.tenantId,
      }),
      1
    );
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_oauth_account_blocks WHERE tenant_id = $1", [
        fixture.tenantId,
      ]),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_grants WHERE id = $1 AND revoked_at IS NOT NULL",
        [fixture.grantId]
      ),
      1
    );
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_access_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL",
        [issued!.familyId]
      ),
      1
    );
    assert.equal(await findActiveOAuthAccessToken(digest(142)), null);
  });

  it("honors RFC 7009 revocation for the owning disabled client", async () => {
    const internal = await seedClient();
    const fixture = await seedAuthorizationCode(internal, 150, true);
    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: fixture.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(151),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(152),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(issued);
    await pool!.query("UPDATE exomem_oauth_clients SET enabled = false WHERE id = $1", [internal]);
    await revokeOAuthTokenForClient({ tokenDigest: digest(151), clientId });
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_token_families WHERE id = $1 AND revoked_at IS NOT NULL",
        [issued!.familyId]
      ),
      1
    );
  });

  it("persists refresh material only for offline access and retains rotation lineage during GC", async () => {
    const internal = await seedClient();
    const online = await seedAuthorizationCode(internal, 120, false);
    const offline = await seedAuthorizationCode(internal, 130, true);
    const onlineResult = await issueOAuthTokensFromCodeAtomic({
      codeDigest: online.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(121),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(122),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    const offlineResult = await issueOAuthTokensFromCodeAtomic({
      codeDigest: offline.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(131),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(132),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(onlineResult?.refreshAllowed, false);
    assert.equal(onlineResult?.refreshInserted, false);
    assert.equal(offlineResult?.refreshAllowed, true);
    assert.equal(offlineResult?.refreshInserted, true);
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_oauth_refresh_tokens WHERE family_id = $1", [
        onlineResult!.familyId,
      ]),
      0
    );
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_oauth_refresh_tokens WHERE family_id = $1", [
        offlineResult!.familyId,
      ]),
      1
    );

    const wrongBinding = await rotateOAuthRefreshTokenAtomic({
      refreshDigest: digest(131),
      replacementRefreshDigest: digest(133),
      accessDigest: digest(134),
      accessExpiresAt: new Date(Date.now() + 60_000),
      clientId,
      resource: `${resource}/wrong`,
    });
    assert.equal(wrongBinding, null);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_refresh_tokens WHERE refresh_digest = $1 AND consumed_at IS NULL",
        [digest(131)]
      ),
      1
    );

    const rotated = await rotateOAuthRefreshTokenAtomic({
      refreshDigest: digest(131),
      replacementRefreshDigest: digest(133),
      accessDigest: digest(134),
      accessExpiresAt: new Date(Date.now() + 60_000),
      clientId,
      resource,
    });
    assert.equal(rotated?.familyId, offlineResult!.familyId);
    await pruneExpiredOAuthState();
    assert.equal(
      await scalar("SELECT count(*) FROM exomem_oauth_refresh_tokens WHERE family_id = $1", [
        offlineResult!.familyId,
      ]),
      2
    );

    const replay = await rotateOAuthRefreshTokenAtomic({
      refreshDigest: digest(131),
      replacementRefreshDigest: digest(135),
      accessDigest: digest(136),
      accessExpiresAt: new Date(Date.now() + 60_000),
      clientId,
      resource,
    });
    assert.equal(replay, null);
    assert.equal(
      await scalar(
        "SELECT count(*) FROM exomem_oauth_token_families WHERE id = $1 AND revoked_at IS NOT NULL",
        [offlineResult!.familyId]
      ),
      1
    );
  });

  it("fails closed for an expired CIMD client without relying on the prune job", async () => {
    const internal = await seedClient();
    const fixture = await seedAuthorizationCode(internal, 250, true);
    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: fixture.codeDigest,
      clientId,
      redirectUri: "https://client.example.test/callback",
      resource,
      pkceChallenge: "challenge",
      refreshDigest: digest(251),
      refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(252),
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(issued);
    await pool!.query(
      `UPDATE exomem_oauth_clients
       SET admission_mode = 'cimd', metadata_document_digest = $1, metadata_fetched_at = now(),
           metadata_ttl_seconds = 300, metadata_expires_at = now() - interval '1 second',
           cimd_host = 'client.example.test'
       WHERE id = $2`,
      [Buffer.alloc(32, 7), internal]
    );
    assert.equal(await findActiveOAuthAccessToken(digest(252)), null);
    assert.equal(await findMcpOAuthAccessToken(digest(252)), null);
    assert.equal(
      await rotateOAuthRefreshTokenAtomic({
        refreshDigest: digest(251),
        replacementRefreshDigest: digest(253),
        accessDigest: digest(254),
        accessExpiresAt: new Date(Date.now() + 60_000),
        clientId,
        resource,
      }),
      null
    );
    await pool!.query(
      `UPDATE exomem_oauth_clients
       SET admission_mode = 'pinned', metadata_document_digest = NULL, metadata_fetched_at = NULL,
           metadata_ttl_seconds = NULL, metadata_expires_at = NULL, cimd_host = NULL
       WHERE id = $1`,
      [internal]
    );
  });

  it("revokes a retired candidate family before any replacement is promoted", async () => {
    const candidateClientId = `candidate-${randomUUID()}`;
    const configDigest = "7".repeat(64);
    const client = await pool!.query(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
         client_platform, oauth_client_config_sha256
       ) VALUES ($1, 'pinned', false, '["https://candidate.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://candidate.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                 'claude', $2)
       RETURNING id`,
      [candidateClientId, configDigest]
    );
    const user = await pool!.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `candidate-lineage-${randomUUID()}@example.test`,
    ]);
    const tenant = await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id, marketplace_reviewer_purpose) VALUES ($1, true) RETURNING id",
      [user.rows[0].id]
    );
    await pool!.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'active', 'active')",
      [tenant.rows[0].id]
    );
    const candidate = await pool!.query(
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, mcp_protocol_versions, contract,
         claude_package_lock, claude_archive_lock, openai_package_lock, openai_archive_lock
       ) VALUES (
         'pending', 'hosted-alpha-agent-v1', $1, 'candidate-test', $2, $3, $4, '1',
         '["2025-11-25"]'::jsonb, '{}'::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb
       ) RETURNING id`,
      [
        resource,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        JSON.stringify({ platform: "claude", artifact_sha256: "d".repeat(64), archive_sha256: "e".repeat(64), compatibility_sha256: "f".repeat(64), schema_contract_sha256: "1".repeat(64), plugin_version: "1.0.0" }),
        JSON.stringify({ platform: "claude", artifact_sha256: "d".repeat(64), archive_sha256: "e".repeat(64), compatibility_sha256: "f".repeat(64), schema_contract_sha256: "1".repeat(64), plugin_version: "1.0.0" }),
        JSON.stringify({ platform: "openai", artifact_sha256: "2".repeat(64), archive_sha256: "3".repeat(64), compatibility_sha256: "4".repeat(64), schema_contract_sha256: "5".repeat(64), plugin_version: "1.0.0", registered_app_id_sha256: "6".repeat(64) }),
        JSON.stringify({ platform: "openai", artifact_sha256: "2".repeat(64), archive_sha256: "3".repeat(64), compatibility_sha256: "4".repeat(64), schema_contract_sha256: "5".repeat(64), plugin_version: "1.0.0", registered_app_id_sha256: "6".repeat(64) }),
      ]
    );
    const assignment = await pool!.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
       ) VALUES ($1, $2, 1, 'active', 'candidate-test', '1', $3, $4, $5, $6, true, $7,
                 now() + interval '1 hour', now()) RETURNING id`,
      [tenant.rows[0].id, candidate.rows[0].id, "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)]
    );
    const stage = await pool!.query(
      `INSERT INTO exomem_staged_client_releases (
         candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest,
         expires_at, evidenced_at
       ) VALUES ($1, 'claude', 'evidenced', $2, $3, $4, $5, '1.0.0', $6, $7,
                 now() + interval '1 hour', now()) RETURNING id`,
      [candidate.rows[0].id, "d".repeat(64), "e".repeat(64), "f".repeat(64), "1".repeat(64), configDigest, "e".repeat(64)]
    );
    const candidatePassword = await hashMarketplaceReviewerPassword("candidate-lineage-password");
    const credential = await pool!.query(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id,
         fixture_version, fixture_payload_digest, created_by_principal_digest, created_at, expires_at
       ) VALUES ('anthropic', 'internal_canary', $1, $2, $3, $4, $5, $6, 1, $7, $8,
                 'candidate-test', $9, $10, now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
      [digest(331), candidatePassword, user.rows[0].id, tenant.rows[0].id, candidate.rows[0].id, assignment.rows[0].id, stage.rows[0].id, client.rows[0].id, "8".repeat(64), digest(332)]
    );
    const grant = await pool!.query(
      `INSERT INTO exomem_oauth_grants (
         user_id, tenant_id, client_id, resource, scopes, refresh_allowed, reviewer_credential_id,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id
       ) VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], true, $5, $6, $7, 1, $8) RETURNING id`,
      [user.rows[0].id, tenant.rows[0].id, client.rows[0].id, resource, credential.rows[0].id, candidate.rows[0].id, assignment.rows[0].id, stage.rows[0].id]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_codes (
         code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at,
         reviewer_credential_id, candidate_id, assignment_id, assignment_generation, staged_client_release_id
       ) VALUES ($1, $2, $3, 'https://candidate.example.test/callback', $4, 'candidate-challenge', true,
                 now() + interval '1 hour', $5, $6, $7, 1, $8)`,
      [digest(333), grant.rows[0].id, client.rows[0].id, resource, credential.rows[0].id, candidate.rows[0].id, assignment.rows[0].id, stage.rows[0].id]
    );

    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest: digest(333), clientId: candidateClientId,
      redirectUri: "https://candidate.example.test/callback", resource, pkceChallenge: "candidate-challenge",
      refreshDigest: digest(334), refreshExpiresAt: new Date(Date.now() + 3_600_000),
      accessDigest: digest(335), accessExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(issued);
    const lineage = await pool!.query(
      `SELECT token.candidate_id, token.assignment_id, token.assignment_generation,
              token.staged_client_release_id, token.reviewer_credential_id, refresh.oauth_client_id
       FROM exomem_oauth_access_tokens AS token
       JOIN exomem_oauth_refresh_tokens AS refresh ON refresh.family_id = token.family_id
       WHERE token.access_digest = $1`,
      [digest(335)]
    );
    assert.deepEqual(lineage.rows[0], {
      candidate_id: candidate.rows[0].id,
      assignment_id: assignment.rows[0].id,
      assignment_generation: "1",
      staged_client_release_id: stage.rows[0].id,
      reviewer_credential_id: credential.rows[0].id,
      oauth_client_id: client.rows[0].id,
    });
    await assert.rejects(
      pool!.query(
        "UPDATE exomem_oauth_access_tokens SET assignment_generation = 2 WHERE access_digest = $1",
        [digest(335)]
      ),
      /candidate OAuth lineage is immutable/i
    );
    assert.equal((await findMcpOAuthAccessToken(digest(335)))?.candidateId, candidate.rows[0].id);

    const legacyClient = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform,
         oauth_client_config_sha256
       ) VALUES ($1, 'pinned', false, '["https://legacy.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://legacy.example.test/callback"]', 'utf8'), 'sha256'), 'claude', $2) RETURNING id`,
      [`legacy-${randomUUID()}`, "f".repeat(64)]
    );
    const legacy = await pool!.query<{ grant_id: string; family_id: string }>(
      `WITH grant_row AS (
         INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed)
         VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], true) RETURNING id
       ), family AS (
         INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
         SELECT id, $3, now() + interval '1 hour' FROM grant_row RETURNING id, grant_id
       ), refresh AS (
         INSERT INTO exomem_oauth_refresh_tokens (refresh_digest, family_id, expires_at)
         SELECT $5, id, now() + interval '1 hour' FROM family
       ), access AS (
         INSERT INTO exomem_oauth_access_tokens (access_digest, grant_id, family_id, client_id, resource, scopes, expires_at)
         SELECT $6, grant_id, id, $3, $4, ARRAY['exomem.read'], now() + interval '1 hour' FROM family
       ) SELECT grant_id, id AS family_id FROM family`,
      [user.rows[0].id, tenant.rows[0].id, legacyClient.rows[0].id, resource, digest(338), digest(339)]
    );
    const unrelatedUser = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id", [`unrelated-${randomUUID()}@example.test`]
    );
    const unrelatedTenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id, marketplace_reviewer_purpose) VALUES ($1, true) RETURNING id",
      [unrelatedUser.rows[0].id]
    );
    const unrelated = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
       VALUES ($1, $2, $3, $4, ARRAY['exomem.read']) RETURNING id`,
      [unrelatedUser.rows[0].id, unrelatedTenant.rows[0].id, legacyClient.rows[0].id, resource]
    );
    const mismatchedClientGrant = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (
         user_id, tenant_id, client_id, resource, scopes, reviewer_credential_id,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id
       ) VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], $5, $6, $7, 1, $8) RETURNING id`,
      [user.rows[0].id, tenant.rows[0].id, (await pool!.query<{ id: string }>(
        `INSERT INTO exomem_oauth_clients (
           client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform,
           oauth_client_config_sha256
         ) VALUES ($1, 'pinned', false, '["https://mismatch.example.test/callback"]'::jsonb,
                   digest(convert_to('["https://mismatch.example.test/callback"]', 'utf8'), 'sha256'),
                   'claude', $2) RETURNING id`,
        [`mismatch-${randomUUID()}`, "e".repeat(64)]
      )).rows[0].id, resource, credential.rows[0].id,
        candidate.rows[0].id, assignment.rows[0].id, stage.rows[0].id]
    );
    await interactiveTransaction((tx) =>
      revokeConflictingCanaryOAuthLineageInTransaction(tx, {
        tenantId: tenant.rows[0].id,
        candidateId: candidate.rows[0].id,
        assignmentId: assignment.rows[0].id,
        assignmentGeneration: 1,
        stagedClientReleaseId: stage.rows[0].id,
        oauthClientId: client.rows[0].id,
      })
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT grant_row.revoked_at IS NOT NULL AS grant_revoked,
                  family.revoked_at IS NOT NULL AS family_revoked,
                  refresh.consumed_at IS NOT NULL AS refresh_consumed,
                  access.revoked_at IS NOT NULL AS access_revoked
           FROM exomem_oauth_grants AS grant_row
           JOIN exomem_oauth_token_families AS family ON family.grant_id = grant_row.id
           JOIN exomem_oauth_refresh_tokens AS refresh ON refresh.family_id = family.id
           JOIN exomem_oauth_access_tokens AS access ON access.family_id = family.id
           WHERE grant_row.id = $1`,
          [legacy.rows[0].grant_id]
        )
      ).rows[0],
      { grant_revoked: true, family_revoked: true, refresh_consumed: true, access_revoked: true }
    );
    assert.equal((await pool!.query("SELECT revoked_at FROM exomem_oauth_grants WHERE id = $1", [unrelated.rows[0].id])).rows[0]?.revoked_at, null);
    assert.equal((await pool!.query("SELECT revoked_at FROM exomem_oauth_grants WHERE id = $1", [grant.rows[0].id])).rows[0]?.revoked_at, null);
    assert.ok((await pool!.query("SELECT revoked_at FROM exomem_oauth_grants WHERE id = $1", [mismatchedClientGrant.rows[0].id])).rows[0]?.revoked_at);

    const providerReview = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
         fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
       ) VALUES ('anthropic', 'provider_review', $1, '$argon2id$integration', $2, $3,
                 'provider-review', $4, $5, now() + interval '1 hour') RETURNING id`,
      [digest(340), user.rows[0].id, tenant.rows[0].id, "9".repeat(64), digest(341)]
    );
    assert.equal(
      await revokeMarketplaceReviewerCredentialAtomic({
        provider: "anthropic",
        operatorPrincipalDigest: digest(342),
      }),
      1
    );
    assert.equal(
      (await pool!.query("SELECT revoked_at FROM exomem_marketplace_reviewer_credentials WHERE id = $1", [providerReview.rows[0].id])).rows[0]?.revoked_at instanceof Date,
      true
    );
    assert.equal(
      (await pool!.query("SELECT revoked_at FROM exomem_marketplace_reviewer_credentials WHERE id = $1", [credential.rows[0].id])).rows[0]?.revoked_at,
      null
    );

    await pool!.query("UPDATE exomem_agent_contract_rollout_assignments SET state = 'retired', activated_at = NULL, ended_at = now() WHERE id = $1", [assignment.rows[0].id]);
    assert.equal(await rotateOAuthRefreshTokenAtomic({
      refreshDigest: digest(334), replacementRefreshDigest: digest(336), accessDigest: digest(337),
      accessExpiresAt: new Date(Date.now() + 60_000), clientId: candidateClientId, resource,
    }), null);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT family.revoked_reason, refresh.consumed_at IS NOT NULL AS refresh_consumed,
                  access.revoked_at IS NOT NULL AS access_revoked
           FROM exomem_oauth_token_families AS family
           JOIN exomem_oauth_refresh_tokens AS refresh ON refresh.family_id = family.id
           JOIN exomem_oauth_access_tokens AS access ON access.family_id = family.id
           WHERE family.id = $1`,
          [issued!.familyId]
        )
      ).rows[0],
      { revoked_reason: "candidate_authority_invalid", refresh_consumed: true, access_revoked: true }
    );

    await pool!.query(
      "UPDATE exomem_agent_contract_rollout_assignments SET state = 'active', activated_at = now(), ended_at = NULL WHERE id = $1",
      [assignment.rows[0].id]
    );
    await pool!.query("UPDATE exomem_oauth_grants SET revoked_at = now() WHERE id = $1", [grant.rows[0].id]);
    const seedCredentialGraph = async (reviewerCredentialId: string, offset: number) => {
      const session = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_sessions (
           user_id, tenant_id, session_digest, csrf_digest, expires_at, reviewer_credential_id,
           candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id
         ) VALUES ($1, $2, $3, $4, now() + interval '1 hour', $5, $6, $7, 1, $8, $9) RETURNING id`,
        [user.rows[0].id, tenant.rows[0].id, digest(offset), digest(offset + 1), reviewerCredentialId, candidate.rows[0].id, assignment.rows[0].id, stage.rows[0].id, client.rows[0].id]
      );
      const graph = await pool!.query<{ grant_id: string; family_id: string; code_id: string }>(
        `WITH grant_row AS (
           INSERT INTO exomem_oauth_grants (
             user_id, tenant_id, client_id, resource, scopes, refresh_allowed, reviewer_credential_id,
             candidate_id, assignment_id, assignment_generation, staged_client_release_id
           ) VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], true, $5, $6, $7, 1, $8) RETURNING id
         ), family AS (
           INSERT INTO exomem_oauth_token_families (
             grant_id, client_id, expires_at, candidate_id, assignment_id, assignment_generation,
             staged_client_release_id, reviewer_credential_id
           ) SELECT id, $3, now() + interval '1 hour', $6, $7, 1, $8, $5 FROM grant_row RETURNING id, grant_id
         ), code AS (
           INSERT INTO exomem_oauth_authorization_codes (
             code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at,
             reviewer_credential_id, candidate_id, assignment_id, assignment_generation, staged_client_release_id
           ) SELECT $9, grant_id, $3, 'https://candidate.example.test/callback', $4, 'rotation-code', true,
                    now() + interval '1 hour', $5, $6, $7, 1, $8 FROM family RETURNING id
         ), refresh AS (
           INSERT INTO exomem_oauth_refresh_tokens (
             refresh_digest, family_id, expires_at, candidate_id, assignment_id, assignment_generation,
             staged_client_release_id, oauth_client_id, reviewer_credential_id
           ) SELECT $10, id, now() + interval '1 hour', $6, $7, 1, $8, $3, $5 FROM family
         ), access AS (
           INSERT INTO exomem_oauth_access_tokens (
             access_digest, grant_id, family_id, client_id, resource, scopes, expires_at,
             candidate_id, assignment_id, assignment_generation, staged_client_release_id, reviewer_credential_id
           ) SELECT $11, grant_id, id, $3, $4, ARRAY['exomem.read'], now() + interval '1 hour',
                    $6, $7, 1, $8, $5 FROM family
         ) SELECT family.grant_id, family.id AS family_id, code.id AS code_id FROM family CROSS JOIN code`,
        [user.rows[0].id, tenant.rows[0].id, client.rows[0].id, resource, reviewerCredentialId, candidate.rows[0].id, assignment.rows[0].id, stage.rows[0].id, digest(offset + 2), digest(offset + 3), digest(offset + 4)]
      );
      return { sessionId: session.rows[0].id, ...graph.rows[0] };
    };
    const oldGraph = await seedCredentialGraph(credential.rows[0].id, 350);
    const replacementCredential = await createInternalCanaryReviewerCredentialAtomic({
      platform: "claude", usernameDigest: digest(360), passwordHash: "$argon2id$integration",
      tenantId: tenant.rows[0].id, candidateId: candidate.rows[0].id,
      assignmentId: assignment.rows[0].id, assignmentGeneration: 1,
      stagedClientReleaseId: stage.rows[0].id, oauthClientId: client.rows[0].id,
      fixtureVersion: "candidate-test", fixturePayloadDigest: "8".repeat(64),
      operatorPrincipalDigest: digest(361), expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    assert.ok(replacementCredential);
    assert.deepEqual(
      (await pool!.query(
        `SELECT credential.revoked_at IS NOT NULL AS credential_revoked, session.revoked_at IS NOT NULL AS session_revoked,
                grant_row.revoked_at IS NOT NULL AS grant_revoked, code.consumed_at IS NOT NULL AS code_consumed,
                family.revoked_at IS NOT NULL AS family_revoked, access.revoked_at IS NOT NULL AS access_revoked,
                refresh.consumed_at IS NOT NULL AS refresh_consumed
         FROM exomem_marketplace_reviewer_credentials AS credential
         JOIN exomem_sessions AS session ON session.id = $2
         JOIN exomem_oauth_grants AS grant_row ON grant_row.id = $3
         JOIN exomem_oauth_authorization_codes AS code ON code.id = $4
         JOIN exomem_oauth_token_families AS family ON family.id = $5
         JOIN exomem_oauth_access_tokens AS access ON access.family_id = family.id
         JOIN exomem_oauth_refresh_tokens AS refresh ON refresh.family_id = family.id
         WHERE credential.id = $1`,
        [credential.rows[0].id, oldGraph.sessionId, oldGraph.grant_id, oldGraph.code_id, oldGraph.family_id]
      )).rows[0],
      { credential_revoked: true, session_revoked: true, grant_revoked: true, code_consumed: true, family_revoked: true, access_revoked: true, refresh_consumed: true }
    );
    const newGraph = await seedCredentialGraph(replacementCredential!.credentialId, 370);
    const survivingProvider = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
         fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at
       ) VALUES ('openai', 'provider_review', $1, '$argon2id$integration', $2, $3,
                 'provider-review', $4, $5, now() + interval '1 hour') RETURNING id`,
      [digest(380), user.rows[0].id, tenant.rows[0].id, "7".repeat(64), digest(381)]
    );
    assert.equal(await revokeInternalCanaryReviewerCredentialAtomic({
      tenantId: tenant.rows[0].id, candidateId: candidate.rows[0].id, assignmentId: assignment.rows[0].id,
      assignmentGeneration: 1, stagedClientReleaseId: stage.rows[0].id, oauthClientId: client.rows[0].id,
      platform: "claude", operatorPrincipalDigest: digest(382),
    }), 1);
    assert.equal((await pool!.query("SELECT revoked_at IS NOT NULL AS revoked FROM exomem_sessions WHERE id = $1", [newGraph.sessionId])).rows[0]?.revoked, true);
    assert.equal((await pool!.query("SELECT revoked_at IS NOT NULL AS revoked FROM exomem_oauth_grants WHERE id = $1", [newGraph.grant_id])).rows[0]?.revoked, true);
    assert.equal((await pool!.query("SELECT revoked_at FROM exomem_marketplace_reviewer_credentials WHERE id = $1", [survivingProvider.rows[0].id])).rows[0]?.revoked_at, null);
    assert.equal((await pool!.query("SELECT deleted_at FROM exomem_tenants WHERE id = $1", [tenant.rows[0].id])).rows[0]?.deleted_at, null);
  });

  it("admits an allowlisted-host CIMD client whose digest matches no promoted artifact", async () => {
    // The whole point of the change: this client's configuration digest is bound to
    // nothing that was ever promoted, which is the situation every ChatGPT connector
    // but one is permanently in.
    const existingCohort = await pool!.query("SELECT 1 FROM exomem_hosted_alpha_cohort LIMIT 1");
    if (existingCohort.rowCount === 0) await seedLiveCohort();
    const host = "connector-admitted.example.test";
    const clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
    const redirectUris = [`https://${host}/callback`];
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["claude", host]
    );
    try {
      const registered = await registerAdmittedCimdClient(clientId, {
        fetchCimd: async () => cimdMetadata(clientId, redirectUris, "auto"),
      });
      assert.ok(registered, "an allowlisted host should register on first authorization");

      const digest = await pool!.query(
        "SELECT oauth_client_config_sha256 AS d, auto_registered FROM exomem_oauth_clients WHERE client_id = $1",
        [clientId]
      );
      assert.equal(digest.rows[0]?.auto_registered, true);
      const pinned = await pool!.query(
        "SELECT claude_oauth_client_config_sha256 AS d FROM exomem_hosted_alpha_cohort LIMIT 1"
      );
      assert.notEqual(
        digest.rows[0]?.d,
        pinned.rows[0]?.d,
        "the test is vacuous unless this client is genuinely unpinned"
      );

      assert.ok(
        await resolveApprovedOAuthClient(clientId),
        "an unpinned client on an admitted host must be admitted"
      );

      // Vary only the condition under test. Same client, same row, same digest --
      // withdraw the host and admission must stop. Without this half the assertion
      // above would still pass if the predicate ignored the allowlist entirely.
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      assert.equal(
        await resolveApprovedOAuthClient(clientId),
        null,
        "withdrawing the host must withdraw admission"
      );
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [clientId]);
    }
  });

  it("refuses to register a CIMD client whose host is not allowlisted, without fetching it", async () => {
    const host = "connector-unlisted.example.test";
    const clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
    let fetched = false;
    const registered = await registerAdmittedCimdClient(clientId, {
      fetchCimd: async () => {
        fetched = true;
        return cimdMetadata(clientId, [`https://${host}/callback`], "auto");
      },
    });
    assert.equal(registered, null);
    assert.equal(fetched, false, "an unlisted host must never drive an outbound fetch");
    const stored = await pool!.query("SELECT 1 FROM exomem_oauth_clients WHERE client_id = $1", [
      clientId,
    ]);
    assert.equal(stored.rowCount, 0);
  });

  it("never lets auto-registration rewrite an operator-managed client", async () => {
    const host = "connector-operator.example.test";
    const clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
    const redirectUris = [`https://${host}/callback`];
    const artifact = await pool!.query(
      "SELECT id FROM exomem_client_artifacts WHERE platform = 'claude' ORDER BY created_at DESC LIMIT 1"
    );
    const operatorConfig = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "cimd",
      clientId,
      redirectUris,
    });
    const priorArtifactConfig = await pool!.query(
      "SELECT oauth_client_config_sha256 AS d FROM exomem_client_artifacts WHERE id = $1",
      [artifact.rows[0]!.id]
    );
    await pool!.query(
      "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
      [operatorConfig, artifact.rows[0]!.id]
    );
    const originalAllowedHosts = process.env.EXOMEM_CIMD_ALLOWED_HOSTS;
    process.env.EXOMEM_CIMD_ALLOWED_HOSTS = host;
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["claude", host]
    );
    try {
      await registerOperatorOAuthClient(
        {
          admissionMode: "cimd",
          platform: "claude",
          artifactId: artifact.rows[0]!.id,
          clientId,
          redirectUris,
        },
        { fetchCimd: async () => cimdMetadata(clientId, redirectUris, "operator") }
      );
      const before = await pool!.query(
        "SELECT authority_version, auto_registered, metadata_document_digest FROM exomem_oauth_clients WHERE client_id = $1",
        [clientId]
      );
      assert.equal(before.rows[0]?.auto_registered, false);

      const hijack = await registerAdmittedCimdClient(clientId, {
        fetchCimd: async () => cimdMetadata(clientId, redirectUris, "hijacked"),
      });
      assert.equal(hijack, null, "an anonymous caller must not adopt an operator client");

      const after = await pool!.query(
        "SELECT authority_version, auto_registered, metadata_document_digest FROM exomem_oauth_clients WHERE client_id = $1",
        [clientId]
      );
      assert.equal(after.rows[0]?.authority_version, before.rows[0]?.authority_version);
      assert.equal(after.rows[0]?.auto_registered, false);
      assert.deepEqual(
        after.rows[0]?.metadata_document_digest,
        before.rows[0]?.metadata_document_digest
      );
    } finally {
      if (originalAllowedHosts === undefined) delete process.env.EXOMEM_CIMD_ALLOWED_HOSTS;
      else process.env.EXOMEM_CIMD_ALLOWED_HOSTS = originalAllowedHosts;
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [clientId]);
      await pool!.query(
        "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
        [priorArtifactConfig.rows[0]?.d ?? null, artifact.rows[0]!.id]
      );
    }
  });

  it("counts the client population bound separately for each provenance", async () => {
    // A full auto-registration partition must not deny an operator a slot, which is
    // the difference between a storage bound and a control-plane outage.
    const probe = `https://partition-probe.example.test/${randomUUID()}/client.json`;
    const operatorAvailable = await pool!.query(
      "SELECT exomem_oauth_client_partition_available($1, false) AS allowed",
      [probe]
    );
    const autoAvailable = await pool!.query(
      "SELECT exomem_oauth_client_partition_available($1, true) AS allowed",
      [probe]
    );
    assert.equal(operatorAvailable.rows[0]?.allowed, true);
    assert.equal(autoAvailable.rows[0]?.allowed, true);

    const counted = await pool!.query(
      `SELECT
         count(*) FILTER (WHERE auto_registered) AS auto_count,
         count(*) FILTER (WHERE NOT auto_registered) AS operator_count
       FROM exomem_oauth_clients`
    );
    assert.ok(
      Number(counted.rows[0]?.auto_count) >= 0 && Number(counted.rows[0]?.operator_count) >= 0,
      "provenance must be recorded per row for the partition to mean anything"
    );
  });

  // ---------------------------------------------------------------------------
  // Host-allowlisted CIMD admission: the claims the change is actually for.
  // ---------------------------------------------------------------------------

  /** Seed a code for an arbitrary client and redirect, unlike the module-level helper. */
  async function seedCodeForClient(input: {
    clientInternalId: string;
    redirectUri: string;
    sequence: number;
    offlineAccess: boolean;
  }) {
    const codeDigest = digest(input.sequence);
    const user = await pool!.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `cimd-${input.sequence}-${randomUUID()}@example.test`,
    ]);
    const tenant = await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
      [user.rows[0].id]
    );
    await pool!.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'active', 'active')`,
      [tenant.rows[0].id]
    );
    const grant = await pool!.query(
      `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, refresh_allowed)
       VALUES ($1, $2, $3, $4, ARRAY['exomem.read'], $5) RETURNING id`,
      [user.rows[0].id, tenant.rows[0].id, input.clientInternalId, resource, input.offlineAccess]
    );
    await pool!.query(
      `INSERT INTO exomem_oauth_authorization_codes (
         code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'challenge', $6, now() + interval '1 hour')`,
      [codeDigest, grant.rows[0].id, input.clientInternalId, input.redirectUri, resource, input.offlineAccess]
    );
    return { codeDigest, grantId: grant.rows[0].id as string, tenantId: tenant.rows[0].id as string };
  }

  it("admits two distinct connectors on the same allowlisted host", async () => {
    // The user-facing claim. Every ChatGPT connector publishes its own client.json
    // under its own connector id, so each carries a different configuration digest.
    // Pinned admission can therefore admit at most one connector on earth; this is
    // the assertion that more than one works, which is what "invite four people"
    // requires.
    const existingCohort = await pool!.query("SELECT 1 FROM exomem_hosted_alpha_cohort LIMIT 1");
    if (existingCohort.rowCount === 0) await seedLiveCohort();
    const host = "connector-siblings.example.test";
    const first = `https://${host}/oauth/${randomUUID()}/client.json`;
    const second = `https://${host}/oauth/${randomUUID()}/client.json`;
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["openai", host]
    );
    try {
      for (const clientId of [first, second]) {
        const registered = await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, [`https://${host}/callback`], clientId),
        });
        assert.ok(registered, `connector ${clientId} should register on an admitted host`);
      }

      const digests = await pool!.query<{ client_id: string; d: string; platform: string }>(
        `SELECT client_id, oauth_client_config_sha256 AS d, client_platform AS platform
         FROM exomem_oauth_clients WHERE client_id = ANY($1::text[]) ORDER BY client_id`,
        [[first, second]]
      );
      assert.equal(digests.rowCount, 2);
      assert.notEqual(
        digests.rows[0]!.d,
        digests.rows[1]!.d,
        "the test is vacuous unless the two connectors really do carry different digests"
      );
      for (const row of digests.rows) {
        assert.equal(row.platform, "openai", "platform must come from the allowlist row");
      }

      assert.ok(await resolveApprovedOAuthClient(first), "first connector must be admitted");
      assert.ok(await resolveApprovedOAuthClient(second), "second connector must be admitted");

      // Neither is the pinned one, so pinned admission alone could not have done this.
      const pinned = await pool!.query<{ d: string | null }>(
        "SELECT openai_oauth_client_config_sha256 AS d FROM exomem_hosted_alpha_cohort LIMIT 1"
      );
      for (const row of digests.rows) {
        assert.notEqual(row.d, pinned.rows[0]?.d);
      }
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = ANY($1::text[])", [
        [first, second],
      ]);
    }
  });

  it("refuses a client_id that is not an https URL, without fetching it", async () => {
    // This is an unauthenticated write path, so the shape check has to come before
    // anything that touches the network. Each of these would otherwise reach the
    // host lookup with a host this code never meant to parse.
    for (const clientId of [
      "http://connector-plain.example.test/oauth/x/client.json",
      "ftp://connector-scheme.example.test/client.json",
      "connector-relative.example.test/client.json",
      "not a url at all",
      "",
    ]) {
      let fetched = false;
      const registered = await registerAdmittedCimdClient(clientId, {
        fetchCimd: async () => {
          fetched = true;
          return cimdMetadata(clientId, ["https://connector-plain.example.test/callback"], "shape");
        },
      });
      assert.equal(registered, null, `${clientId} must not register`);
      assert.equal(fetched, false, `${clientId} must never drive an outbound fetch`);
    }
  });

  it("re-admits a connector whose cached metadata went stale and disabled", async () => {
    // Design decision 2: registration must fire for an expired-disabled row as well
    // as an absent one. A connector that goes quiet past its TTL is disabled by the
    // cache, and without this path it could never come back without an operator.
    const existingCohort = await pool!.query("SELECT 1 FROM exomem_hosted_alpha_cohort LIMIT 1");
    if (existingCohort.rowCount === 0) await seedLiveCohort();
    const host = "connector-stale.example.test";
    const clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
    const redirectUris = [`https://${host}/callback`];
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["openai", host]
    );
    try {
      assert.ok(
        await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, redirectUris, "fresh"),
        })
      );
      assert.ok(await resolveApprovedOAuthClient(clientId));

      // Age it out exactly the way the cache does.
      await pool!.query(
        `UPDATE exomem_oauth_clients
         SET metadata_expires_at = now() - interval '1 hour', enabled = false
         WHERE client_id = $1`,
        [clientId]
      );
      assert.equal(
        await resolveApprovedOAuthClient(clientId),
        null,
        "a stale disabled row must not admit on its own"
      );

      assert.ok(
        await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, redirectUris, "refetched"),
        }),
        "an admitted host must be able to revive its own stale row"
      );
      assert.ok(
        await resolveApprovedOAuthClient(clientId),
        "the revived row must admit again"
      );
      const revived = await pool!.query<{ auto_registered: boolean; enabled: boolean }>(
        "SELECT auto_registered, enabled FROM exomem_oauth_clients WHERE client_id = $1",
        [clientId]
      );
      assert.equal(revived.rows[0]?.auto_registered, true);
      assert.equal(revived.rows[0]?.enabled, true);
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [clientId]);
    }
  });

  it("refuses a further auto-registration at its bound while leaving operator slots free", async () => {
    // The reason the bound was partitioned at all: anonymous registration is an
    // unauthenticated write path, and a full one must degrade into "no more
    // connectors" rather than "no more operator control".
    const host = "connector-bound.example.test";
    const filler = `cimd-bound-${randomUUID()}`;
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["openai", host]
    );
    try {
      const existing = await pool!.query<{ n: string }>(
        "SELECT count(*) AS n FROM exomem_oauth_clients WHERE auto_registered"
      );
      const shortfall = 128 - Number(existing.rows[0]!.n);
      assert.ok(shortfall > 0, "fixture assumes the auto partition starts below its bound");
      await pool!.query(
        `INSERT INTO exomem_oauth_clients (
           client_id, admission_mode, enabled, auto_registered, redirect_uris, redirect_uris_digest,
           client_platform, oauth_client_config_sha256, cimd_host, metadata_document_digest,
           metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at, metadata_provenance
         )
         SELECT
           format('https://%s/oauth/%s-%s/client.json', $1::text, $2::text, step),
           'cimd', true, true,
           '["https://filler.example.test/callback"]'::jsonb,
           digest(convert_to('["https://filler.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
           'openai',
           encode(digest(convert_to(format('%s-%s', $2::text, step), 'utf8'), 'sha256'), 'hex'),
           $1::text,
           digest(convert_to(format('doc-%s-%s', $2::text, step), 'utf8'), 'sha256'),
           now(), 3600, now() + interval '1 hour', '{}'::jsonb
         FROM generate_series(1, $3::int) AS step`,
        [host, filler, shortfall]
      );

      const overflow = `https://${host}/oauth/${randomUUID()}/client.json`;
      assert.equal(
        await registerAdmittedCimdClient(overflow, {
          fetchCimd: async () => cimdMetadata(overflow, [`https://${host}/callback`], "overflow"),
        }),
        null,
        "a full auto partition must refuse a new connector"
      );
      assert.equal(
        (await pool!.query("SELECT 1 FROM exomem_oauth_clients WHERE client_id = $1", [overflow]))
          .rowCount,
        0
      );

      // The whole point: operators are unaffected.
      const operatorProbe = `https://operator-unaffected.example.test/${randomUUID()}/client.json`;
      const operatorAvailable = await pool!.query<{ allowed: boolean }>(
        "SELECT exomem_oauth_client_partition_available($1, false) AS allowed",
        [operatorProbe]
      );
      assert.equal(
        operatorAvailable.rows[0]?.allowed,
        true,
        "a full auto partition must not consume operator slots"
      );
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id LIKE $1", [
        `%${filler}%`,
      ]);
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
    }
  });

  it("admits a host-allowlisted connector at every stage, and withdraws it at every stage", async () => {
    // The clause lives in nine separate predicates. A missed one does not fail at
    // authorize -- it fails later, as a connector that signs in and then cannot call
    // a tool, which reads as an intermittent client bug. Drive one client through
    // the stages a real connector traverses, then withdraw the host and require
    // every stage to stop. The negative half is the actual drift guard: if a
    // predicate ignored the allowlist it would keep admitting after withdrawal.
    const existingCohort = await pool!.query("SELECT 1 FROM exomem_hosted_alpha_cohort LIMIT 1");
    if (existingCohort.rowCount === 0) await seedLiveCohort();
    const host = "connector-crossstage.example.test";
    const clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
    const redirectUri = `https://${host}/callback`;
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["openai", host]
    );
    try {
      assert.ok(
        await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, [redirectUri], "cross-stage"),
        })
      );
      const internal = await pool!.query<{ id: string }>(
        "SELECT id FROM exomem_oauth_clients WHERE client_id = $1",
        [clientId]
      );
      const clientInternalId = internal.rows[0]!.id;

      // 1. /authorize
      assert.ok(await resolveApprovedOAuthClient(clientId), "authorize must admit");

      // 2. token exchange
      const first = await seedCodeForClient({
        clientInternalId,
        redirectUri,
        sequence: 900,
        offlineAccess: true,
      });
      const issued = await issueOAuthTokensFromCodeAtomic({
        codeDigest: first.codeDigest,
        clientId,
        redirectUri,
        resource,
        pkceChallenge: "challenge",
        refreshDigest: digest(901),
        refreshExpiresAt: new Date(Date.now() + 3_600_000),
        accessDigest: digest(902),
        accessExpiresAt: new Date(Date.now() + 60_000),
      });
      assert.ok(issued, "token exchange must admit");

      // 3. bearer use, and 4. the MCP call itself
      assert.ok(await findActiveOAuthAccessToken(digest(902)), "access-token use must admit");
      assert.equal(
        (await findMcpOAuthAccessToken(digest(902)))?.grantId,
        first.grantId,
        "the MCP lookup must admit"
      );

      // 5. refresh
      assert.ok(
        await rotateOAuthRefreshTokenAtomic({
          refreshDigest: digest(901),
          replacementRefreshDigest: digest(903),
          accessDigest: digest(904),
          accessExpiresAt: new Date(Date.now() + 60_000),
          clientId,
          resource,
        }),
        "refresh must admit"
      );
      assert.ok(await findMcpOAuthAccessToken(digest(904)), "the rotated token must admit");

      // Vary only the condition under test.
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);

      assert.equal(
        await resolveApprovedOAuthClient(clientId),
        null,
        "authorize must stop admitting once the host is withdrawn"
      );
      assert.equal(
        await findActiveOAuthAccessToken(digest(904)),
        null,
        "access-token use must stop admitting once the host is withdrawn"
      );
      assert.equal(
        await findMcpOAuthAccessToken(digest(904)),
        null,
        "the MCP lookup must stop admitting once the host is withdrawn"
      );
      assert.equal(
        await rotateOAuthRefreshTokenAtomic({
          refreshDigest: digest(903),
          replacementRefreshDigest: digest(905),
          accessDigest: digest(906),
          accessExpiresAt: new Date(Date.now() + 60_000),
          clientId,
          resource,
        }),
        null,
        "refresh must stop admitting once the host is withdrawn"
      );
      const second = await seedCodeForClient({
        clientInternalId,
        redirectUri,
        sequence: 910,
        offlineAccess: true,
      });
      assert.equal(
        await issueOAuthTokensFromCodeAtomic({
          codeDigest: second.codeDigest,
          clientId,
          redirectUri,
          resource,
          pkceChallenge: "challenge",
          refreshDigest: digest(911),
          refreshExpiresAt: new Date(Date.now() + 3_600_000),
          accessDigest: digest(912),
          accessExpiresAt: new Date(Date.now() + 60_000),
        }),
        null,
        "token exchange must stop admitting once the host is withdrawn"
      );
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      // The client now owns a grant graph, and the foreign keys say so. Unwind it in
      // dependency order rather than leaving the row behind, so the population-bound
      // test that follows still counts a clean partition.
      await pool!.query(
        `DELETE FROM exomem_oauth_grants WHERE client_id IN (
           SELECT id FROM exomem_oauth_clients WHERE client_id = $1)`,
        [clientId]
      );
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [clientId]);
    }
  });
});
