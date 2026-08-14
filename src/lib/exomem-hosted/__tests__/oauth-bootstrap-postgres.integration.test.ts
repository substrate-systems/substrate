import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  storeExomemAgentContractCandidate,
  storeRetainedExomemAgentContractCandidate,
} from "../agent-contract-store";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  type ExomemSql,
} from "../db";
import { ExomemHostedError } from "../errors";
import { exomemContractFixture0500 } from "../gateway-contract-0-50-0";
import { SqlLifecycleStore } from "../lifecycle-store";
import { EXOMEM_ALPHA_CAPACITY } from "../oauth-admission";
import {
  admitFirstOAuthInviteAtomic,
  attachExistingOwnerAuthorizationAtomic,
  createAuthorizationTransaction,
  findPendingOAuthAuthorization,
  issueOAuthTokensFromCodeAtomic,
} from "../oauth-store";
import { oauthClientConfigSha256 } from "../oauth-client-admission";
import {
  createReviewerOAuthBootstrapAuthority,
  registerOperatorOAuthClient,
  revokeReviewerOAuthBootstrapAuthority,
} from "../operator-controls";
import {
  createInternalCanaryReviewerCredentialAtomic,
  createMarketplaceReviewerOAuthSessionAtomic,
} from "../reviewer-access-store";
import { FakeCellProvisioner } from "../provisioner";
import { expectedCellConfiguration, LifecycleReconciler } from "../reconciler";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "bootstrap-reviewer-client";
const redirectUri = "http://127.0.0.1:47831/callback";
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
let pool: Pool | undefined;
let schema: string | undefined;

function digest(value: number): Buffer {
  const result = Buffer.alloc(32);
  result.writeUInt32BE(value, 28);
  return result;
}

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function transaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await work(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForCohortLockWaiters(expected = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool!.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
       FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
    );
    if ((rows[0]?.waiting ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${expected} cohort lock waiter(s)`);
}

async function waitForAuthorityWallExpiry(authorityId: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await pool!.query<{ expired: boolean }>(
      `SELECT clock_timestamp() >= expires_at AS expired
       FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE id = $1`,
      [authorityId]
    );
    if (rows[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("bootstrap authority did not reach wall-clock expiry");
}

async function waitForBlockedQuery(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool!.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND datname = current_database()
           AND query LIKE $1 AND wait_event_type = 'Lock'
       ) AS waiting`,
      [pattern]
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`query did not block for pattern ${pattern}`);
}

async function setCapacity(slots = 4): Promise<void> {
  await pool!.query(
    `UPDATE exomem_capacity_pools
     SET storage_capacity_bytes = $1, runtime_capacity_slots = $2,
         provision_reservation_capacity = $2, provision_claim_capacity = $2,
         configured_at = now(), reserved_storage_bytes = 0,
         reserved_runtime_slots = 0, reserved_provision_slots = 0,
         updated_at = now()`,
    [EXOMEM_ALPHA_CAPACITY.storageBytes * slots, slots]
  );
}

async function resetDatabase(): Promise<void> {
  await pool!.query(
    `TRUNCATE TABLE users, exomem_invites, exomem_oauth_clients,
       exomem_agent_contract_candidates, exomem_agent_contract_profile_authority,
       exomem_capacity_pools RESTART IDENTITY CASCADE`
  );
  await pool!.query(
    `INSERT INTO exomem_capacity_pools (
       pool_key, storage_capacity_bytes, runtime_capacity_slots,
       provision_reservation_capacity, provision_claim_capacity
     ) VALUES ('exomem-hosted-alpha', 0, 0, 0, 0)`
  );
  await setCapacity();
}

type BootstrapFixture = {
  sequence: number;
  candidateId: string;
  candidate: {
    profile_id: string;
    source_release: string;
    protocol_version: string;
    command_fingerprint: string;
    schema_digest: string;
    compatibility_digest: string;
  };
  clientId: string;
  redirectUri: string;
  config: string;
  stageId: string;
  clientIdRecord: string;
  clientAuthorityVersion: string;
  inviteId: string;
  inviteDigest: Buffer;
};

async function createBootstrapFixture(sequence: number) {
  const candidateId = await storeExomemAgentContractCandidate();
  const candidate = await pool!.query<BootstrapFixture["candidate"]>(
    `SELECT profile_id, source_release, protocol_version, command_fingerprint,
            schema_digest, compatibility_digest
     FROM exomem_agent_contract_candidates WHERE id = $1`,
    [candidateId]
  );
  const fixtureClientId = `bootstrap-race-client-${sequence}`;
  const fixtureRedirect = `http://127.0.0.1:${48000 + sequence}/callback`;
  const config = oauthClientConfigSha256({
    platform: "claude",
    admissionMode: "pinned",
    clientId: fixtureClientId,
    redirectUris: [fixtureRedirect],
  });
  const stage = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_staged_client_releases (
       candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
       contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest, expires_at
     ) VALUES ($1, 'claude', 'staged', $2, $3, $4, $5, '0.1.0', $6, $7, now() + interval '20 minutes') RETURNING id`,
    [
      candidateId,
      "a".repeat(64),
      "b".repeat(64),
      candidate.rows[0]!.compatibility_digest,
      candidate.rows[0]!.schema_digest,
      config,
      "c".repeat(64),
    ]
  );
  const client = await pool!.query<{ id: string; authority_version: string }>(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform, oauth_client_config_sha256
     ) VALUES ($1, 'pinned', false, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), 'claude', $3)
     RETURNING id, authority_version`,
    [fixtureClientId, JSON.stringify([fixtureRedirect]), config]
  );
  const invite = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits,
       marketplace_reviewer_purpose, created_by_principal_digest, delivery_state, delivered_at, expires_at
     ) VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, true, $3, 'sent', now(), now() + interval '20 minutes') RETURNING id`,
    [digest(sequence * 100), `bootstrap-race-${sequence}@example.test`, digest(sequence * 100 + 1)]
  );
  return {
    sequence,
    candidateId,
    candidate: candidate.rows[0]!,
    clientId: fixtureClientId,
    redirectUri: fixtureRedirect,
    config,
    stageId: stage.rows[0]!.id,
    clientIdRecord: client.rows[0]!.id,
    clientAuthorityVersion: client.rows[0]!.authority_version,
    inviteId: invite.rows[0]!.id,
    inviteDigest: digest(sequence * 100),
  } satisfies BootstrapFixture;
}

async function prepareBootstrap(sequence: number, authorityLifetimeMs = 10 * 60_000) {
  const fixture = await createBootstrapFixture(sequence);
  const authority = await createReviewerOAuthBootstrapAuthority({
    inviteId: fixture.inviteId,
    stagedClientReleaseId: fixture.stageId,
    oauthClientId: fixture.clientIdRecord,
    expiresAt: new Date(Date.now() + authorityLifetimeMs),
    operatorPrincipalDigest: digest(sequence * 1_000 + 1),
  });
  assert.ok(authority);
  const transactionDigest = digest(sequence * 1_000 + 2);
  const authorization = await createAuthorizationTransaction({
    transactionDigest,
    stateDigest: digest(sequence * 1_000 + 3),
    stateEnvelope: { version: 1, algorithm: "A256GCM", iv: "iv", ciphertext: "cipher", tag: "tag" },
    formNonceDigest: digest(sequence * 1_000 + 4),
    continuationBinding: digest(sequence * 1_000 + 5),
    clientId: fixture.clientId,
    redirectUri: fixture.redirectUri,
    resource,
    scopes: ["exomem.read", "offline_access"],
    pkceChallenge: `bootstrap-${sequence}`,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  assert.ok(authorization);
  const redeemInput = {
    inviteDigest: fixture.inviteDigest,
    transactionDigest,
    sessionDigest: digest(sequence * 1_000 + 6),
    csrfDigest: digest(sequence * 1_000 + 7),
    sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
    codeDigest: digest(sequence * 1_000 + 8),
    codeExpiresAt: new Date(Date.now() + 10 * 60_000),
  };
  return { fixture, authority, transactionDigest, redeemInput };
}

async function bootstrapGraphSnapshot(): Promise<Record<string, string>> {
  const { rows } = await pool!.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM users)::text AS users,
       (SELECT count(*) FROM exomem_tenants)::text AS tenants,
       (SELECT count(*) FROM exomem_entitlements)::text AS entitlements,
       (SELECT count(*) FROM exomem_agent_contract_rollout_assignments)::text AS assignments,
       (SELECT count(*) FROM exomem_lifecycle_operations)::text AS operations,
       (SELECT count(*) FROM exomem_capacity_allocations)::text AS allocations,
       (SELECT count(*) FROM exomem_sessions)::text AS sessions,
       (SELECT count(*) FROM exomem_oauth_grants)::text AS grants,
       (SELECT count(*) FROM exomem_oauth_authorization_codes)::text AS codes,
       (SELECT count(*) FROM exomem_oauth_token_families)::text AS families,
       (SELECT count(*) FROM exomem_oauth_access_tokens)::text AS access_tokens,
       (SELECT count(*) FROM exomem_oauth_refresh_tokens)::text AS refresh_tokens,
       reserved_storage_bytes::text, reserved_runtime_slots::text, reserved_provision_slots::text
     FROM exomem_capacity_pools WHERE pool_key = 'exomem-hosted-alpha'`
  );
  return rows[0]!;
}

async function assertBootstrapReusable(prepared: Awaited<ReturnType<typeof prepareBootstrap>>) {
  const { rows } = await pool!.query<{
    invite_consumed_at: Date | null;
    invite_revoked_at: Date | null;
    transaction_consumed_at: Date | null;
    authority_state: string;
    client_enabled: boolean;
  }>(
    `SELECT invite.consumed_at AS invite_consumed_at, invite.revoked_at AS invite_revoked_at,
            transaction.consumed_at AS transaction_consumed_at, authority.state AS authority_state,
            client.enabled AS client_enabled
     FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
     JOIN exomem_invites AS invite ON invite.id = authority.invite_id
     JOIN exomem_oauth_authorization_transactions AS transaction
       ON transaction.reviewer_bootstrap_authority_id = authority.id
     JOIN exomem_oauth_clients AS client ON client.id = authority.oauth_client_id
     WHERE authority.id = $1`,
    [prepared.authority.id]
  );
  assert.deepEqual(rows, [
    {
      invite_consumed_at: null,
      invite_revoked_at: null,
      transaction_consumed_at: null,
      authority_state: "active",
      client_enabled: true,
    },
  ]);
}

async function seedReviewerTenant(
  fixture: BootstrapFixture,
  sequence: number,
  assignmentState: "preparing" | "active" | "failed" | "expired",
  options: { boundReadyCell?: boolean } = {}
) {
  const owner = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`reviewer-history-${sequence}@example.test`]
  );
  const tenant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_tenants (
       owner_user_id, status, desired_state, marketplace_reviewer_purpose
     ) VALUES ($1, $2, 'running', true) RETURNING id`,
    [owner.rows[0]!.id, options.boundReadyCell ? "active" : "provisioning"]
  );
  const terminal = assignmentState === "failed" || assignmentState === "expired";
  const assignment = await pool!.query<{ id: string; generation: string }>(
    `INSERT INTO exomem_agent_contract_rollout_assignments (
       tenant_id, candidate_id, generation, state, source_release, protocol_version,
       command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
       marketplace_reviewer_purpose, created_by_principal_digest, created_at, expires_at,
       activated_at, ended_at
     ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, true, $10,
       CASE WHEN $3 = 'expired' THEN now() - interval '2 hours' ELSE now() END,
       CASE WHEN $3 = 'expired' THEN now() - interval '1 hour' ELSE now() + interval '1 hour' END,
       CASE WHEN $3 = 'active' THEN now() ELSE NULL END,
       CASE WHEN $11 THEN now() ELSE NULL END)
     RETURNING id, generation`,
    [
      tenant.rows[0]!.id,
      fixture.candidateId,
      assignmentState,
      fixture.candidate.source_release,
      fixture.candidate.protocol_version,
      fixture.candidate.command_fingerprint,
      fixture.candidate.schema_digest,
      fixture.candidate.compatibility_digest,
      exomemContractFixture0500.digest,
      sequence.toString(16).padStart(64, "0"),
      terminal,
    ]
  );
  let cellId: string | null = null;
  if (options.boundReadyCell) {
    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version,
         release_version, readiness_code
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, 'CELL_READY') RETURNING id`,
      [tenant.rows[0]!.id, fixture.candidate.protocol_version, fixture.candidate.source_release]
    );
    cellId = cell.rows[0]!.id;
    await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      cellId,
      tenant.rows[0]!.id,
    ]);
  }
  return {
    ownerId: owner.rows[0]!.id,
    tenantId: tenant.rows[0]!.id,
    assignmentId: assignment.rows[0]!.id,
    assignmentGeneration: Number(assignment.rows[0]!.generation),
    cellId,
  };
}

async function seedInternalCanaryCredential(
  fixture: BootstrapFixture,
  reviewer: Awaited<ReturnType<typeof seedReviewerTenant>>,
  sequence: number,
  lifecycle: "valid" | "revoked" | "expired"
): Promise<string> {
  const { rows } = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_marketplace_reviewer_credentials (
       provider, credential_kind, username_digest, password_hash, owner_user_id, tenant_id,
       candidate_id, assignment_id, assignment_generation, staged_client_release_id,
       oauth_client_id, fixture_version, fixture_payload_digest, created_by_principal_digest,
       created_at, expires_at, revoked_at
     ) VALUES ('anthropic', 'internal_canary', $1, '$argon2id$fixture', $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       CASE WHEN $12 = 'expired' THEN now() - interval '2 hours' ELSE now() END,
       CASE WHEN $12 = 'expired' THEN now() - interval '1 hour' ELSE now() + interval '1 hour' END,
       CASE WHEN $12 = 'revoked' THEN now() ELSE NULL END)
     RETURNING id`,
    [
      digest(sequence * 100 + 50),
      reviewer.ownerId,
      reviewer.tenantId,
      fixture.candidateId,
      reviewer.assignmentId,
      reviewer.assignmentGeneration,
      fixture.stageId,
      fixture.clientIdRecord,
      `fixture-${sequence}`,
      sequence.toString(16).padStart(64, "0"),
      digest(sequence * 100 + 51),
      lifecycle,
    ]
  );
  return rows[0]!.id;
}

async function seedDirtyReviewerHistory(fixture: BootstrapFixture): Promise<void> {
  const failed = await seedReviewerTenant(fixture, 301, "failed");
  await seedInternalCanaryCredential(fixture, failed, 301, "revoked");
  const expired = await seedReviewerTenant(fixture, 302, "expired");
  await seedInternalCanaryCredential(fixture, expired, 302, "expired");
  await seedReviewerTenant(fixture, 303, "preparing");
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
  const contract = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_agent_contract_candidates (
       state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
       compatibility_digest, protocol_version, mcp_protocol_versions, contract,
       claude_package_lock, claude_archive_lock, openai_package_lock, openai_archive_lock,
       promoted_at
     ) VALUES ('live', 'hosted-alpha-agent-v1', $1, 'live-test', $2, $3, $4, '1',
       '["2025-11-25"]'::jsonb, '{}'::jsonb, $5::jsonb, $6::jsonb, $7::jsonb,
       $8::jsonb, now()) RETURNING id`,
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
  for (const artifact of [claude, openai]) {
    await pool!.query(
      `INSERT INTO exomem_client_artifacts (
         platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, client_identity_sha256, paired_run_hmac_sha256,
         exomem_identity_hmac_sha256, tenant_hmac_sha256, install_url, evidence_sha256,
         result_sha256, contract_candidate_id, registered_app_id_sha256,
         oauth_client_config_sha256, observed_at, promoted_at
       ) VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10,
         'https://example.test/install', $11, $12, $13::uuid, $14, $15, now(), now())`,
      [
        artifact.platform,
        artifact.artifact_sha256,
        artifact.archive_sha256,
        artifact.compatibility_sha256,
        artifact.schema_contract_sha256,
        artifact.plugin_version,
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
        "4".repeat(64),
        "5".repeat(64),
        "6".repeat(64),
        artifact.platform === "openai" ? contract.rows[0]!.id : null,
        artifact.platform === "openai" ? openai.registered_app_id_sha256 : null,
        "f".repeat(64),
      ]
    );
  }
}

async function assertClientUnchanged(fixture: BootstrapFixture): Promise<void> {
  const { rows } = await pool!.query(
    `SELECT enabled, reviewer_bootstrap_ever_authorized,
            authority_version::text AS authority_version
     FROM exomem_oauth_clients WHERE id = $1`,
    [fixture.clientIdRecord]
  );
  assert.deepEqual(rows, [
    {
      enabled: false,
      reviewer_bootstrap_ever_authorized: false,
      authority_version: fixture.clientAuthorityVersion,
    },
  ]);
}

async function assertRedemptionFailsWithoutGraphMutation(
  prepared: Awaited<ReturnType<typeof prepareBootstrap>>
): Promise<void> {
  const before = await bootstrapGraphSnapshot();
  assert.equal(await admitFirstOAuthInviteAtomic(prepared.redeemInput), null);
  assert.deepEqual(await bootstrapGraphSnapshot(), before);
}

async function consumeInviteForMutation(
  fixture: BootstrapFixture,
  sequence: number
): Promise<void> {
  const owner = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`consumed-invite-${sequence}@example.test`]
  );
  const tenant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
     VALUES ($1, 'provisioning', 'running') RETURNING id`,
    [owner.rows[0]!.id]
  );
  const session = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes') RETURNING id`,
    [
      owner.rows[0]!.id,
      tenant.rows[0]!.id,
      digest(sequence * 100 + 70),
      digest(sequence * 100 + 71),
    ]
  );
  await pool!.query(
    `UPDATE exomem_invites
     SET consumed_at = now(), consumed_by_user_id = $1, redeemed_tenant_id = $2,
         redeemed_session_id = $3
     WHERE id = $4`,
    [owner.rows[0]!.id, tenant.rows[0]!.id, session.rows[0]!.id, fixture.inviteId]
  );
}

describe("reviewer OAuth bootstrap PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `oauth_bootstrap_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(transaction);
  });

  beforeEach(async () => {
    await resetDatabase();
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

  it("redeems one bounded authority into a complete nonlegacy reviewer graph", async () => {
    const candidateId = await storeExomemAgentContractCandidate();
    const candidate = await pool!.query<{ schema_digest: string; compatibility_digest: string }>(
      "SELECT schema_digest, compatibility_digest FROM exomem_agent_contract_candidates WHERE id = $1",
      [candidateId]
    );
    const config = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId,
      redirectUris: [redirectUri],
    });
    const stage = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_staged_client_releases (
         candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest, expires_at
       ) VALUES ($1, 'claude', 'staged', $2, $3, $4, $5, '0.1.0', $6, $7, now() + interval '20 minutes')
       RETURNING id`,
      [
        candidateId,
        "a".repeat(64),
        "b".repeat(64),
        candidate.rows[0]!.compatibility_digest,
        candidate.rows[0]!.schema_digest,
        config,
        "e".repeat(64),
      ]
    );
    const client = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform, oauth_client_config_sha256
       ) VALUES ($1, 'pinned', false, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), 'claude', $3)
       RETURNING id`,
      [clientId, JSON.stringify([redirectUri]), config]
    );
    const invite = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits,
         marketplace_reviewer_purpose, created_by_principal_digest, delivery_state, delivered_at, expires_at
       ) VALUES ($1, 'bootstrap-reviewer@example.test', 'complimentary', '[]'::jsonb, '{}'::jsonb,
         true, $2, 'sent', now(), now() + interval '20 minutes') RETURNING id`,
      [digest(1), digest(2)]
    );
    await pool!.query(
      `UPDATE exomem_capacity_pools
       SET storage_capacity_bytes = 10737418240, runtime_capacity_slots = 2,
           provision_reservation_capacity = 2, provision_claim_capacity = 1, configured_at = now()`
    );

    const authority = await createReviewerOAuthBootstrapAuthority({
      inviteId: invite.rows[0]!.id,
      stagedClientReleaseId: stage.rows[0]!.id,
      oauthClientId: client.rows[0]!.id,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      operatorPrincipalDigest: digest(3),
    });
    assert.ok(authority);
    assert.ok(
      await createAuthorizationTransaction({
        transactionDigest: digest(4),
        stateDigest: digest(5),
        stateEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "iv",
          ciphertext: "cipher",
          tag: "tag",
        },
        formNonceDigest: digest(6),
        continuationBinding: digest(7),
        clientId,
        redirectUri,
        resource,
        scopes: ["exomem.read", "offline_access"],
        pkceChallenge: "bootstrap-challenge",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
    );
    assert.equal((await findPendingOAuthAuthorization(digest(4)))?.clientId, clientId);
    const redeemed = await admitFirstOAuthInviteAtomic({
      inviteDigest: digest(1),
      transactionDigest: digest(4),
      sessionDigest: digest(8),
      csrfDigest: digest(9),
      sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
      codeDigest: digest(10),
      codeExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.ok(redeemed);
    const graph = await pool!.query<{
      legacy_unmetered: boolean;
      assignment_state: string;
      operation_type: string;
      target_matches: boolean;
      provisioner_wire_protocol: string;
      authority_state: string;
      allocation_state: string;
      token_count: string;
      outcome_tenant_id: string;
      outcome_assignment_id: string;
    }>(
      `SELECT tenant.legacy_unmetered, assignment.state AS assignment_state, operation.operation_type,
              operation.target_candidate_id = $1::uuid AND operation.target_assignment_id = assignment.id
                AND operation.target_assignment_generation = assignment.generation AS target_matches,
              operation.provisioner_wire_protocol, authority.state AS authority_state, allocation.state AS allocation_state,
              authority.outcome_tenant_id, authority.outcome_assignment_id,
              (SELECT count(*) FROM exomem_oauth_access_tokens)::text AS token_count
       FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
       JOIN exomem_tenants AS tenant ON tenant.id = authority.outcome_tenant_id
       JOIN exomem_agent_contract_rollout_assignments AS assignment ON assignment.id = authority.outcome_assignment_id
       JOIN exomem_lifecycle_operations AS operation ON operation.id = authority.outcome_operation_id
       JOIN exomem_capacity_allocations AS allocation ON allocation.operation_id = operation.id
       WHERE authority.id = $2::uuid`,
      [candidateId, authority!.id]
    );
    assert.deepEqual(graph.rows, [
      {
        legacy_unmetered: false,
        assignment_state: "preparing",
        operation_type: "provision",
        target_matches: true,
        provisioner_wire_protocol: "exomem-cell-provisioner.v1",
        authority_state: "consumed",
        allocation_state: "reserved",
        outcome_tenant_id: graph.rows[0]?.outcome_tenant_id,
        outcome_assignment_id: graph.rows[0]?.outcome_assignment_id,
        token_count: "0",
      },
    ]);
    await assert.rejects(
      pool!.query(
        `UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
         SET outcome_assignment_generation = 2 WHERE id = $1`,
        [authority!.id]
      ),
      /immutable/
    );

    const candidateB = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, mcp_protocol_versions, contract,
         claude_package_lock, claude_archive_lock, openai_package_lock, openai_archive_lock
       ) SELECT 'pending', profile_id, endpoint, source_release, command_fingerprint, schema_digest,
                compatibility_digest, protocol_version, mcp_protocol_versions, contract,
                claude_package_lock, claude_archive_lock, openai_package_lock, openai_archive_lock
         FROM exomem_agent_contract_candidates WHERE id = $1 RETURNING id`,
      [candidateId]
    );
    const clientBId = "bootstrap-reviewer-client-b";
    const configB = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId: clientBId,
      redirectUris: ["http://127.0.0.1:47832/callback"],
    });
    const stageB = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_staged_client_releases (
         candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest, expires_at
       ) VALUES ($1, 'claude', 'staged', $2, $3, $4, $5, '0.1.0', $6, $7, now() + interval '20 minutes') RETURNING id`,
      [
        candidateB.rows[0]!.id,
        "1".repeat(64),
        "2".repeat(64),
        candidate.rows[0]!.compatibility_digest,
        candidate.rows[0]!.schema_digest,
        configB,
        "3".repeat(64),
      ]
    );
    const clientB = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform, oauth_client_config_sha256
       ) VALUES ($1, 'pinned', false, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), 'claude', $3) RETURNING id`,
      [clientBId, JSON.stringify(["http://127.0.0.1:47832/callback"]), configB]
    );
    const inviteB = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities, entitlement_limits,
         marketplace_reviewer_purpose, created_by_principal_digest, delivery_state, delivered_at, expires_at
       ) VALUES ($1, 'bootstrap-reviewer-b@example.test', 'complimentary', '[]'::jsonb, '{}'::jsonb,
         true, $2, 'sent', now(), now() + interval '20 minutes') RETURNING id`,
      [digest(11), digest(12)]
    );
    const authorityB = await createReviewerOAuthBootstrapAuthority({
      inviteId: inviteB.rows[0]!.id,
      stagedClientReleaseId: stageB.rows[0]!.id,
      oauthClientId: clientB.rows[0]!.id,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      operatorPrincipalDigest: digest(13),
    });
    assert.ok(authorityB);
    assert.equal(
      await createInternalCanaryReviewerCredentialAtomic({
        platform: "claude",
        usernameDigest: digest(14),
        passwordHash: "$argon2id$bootstrap-fence",
        tenantId: graph.rows[0]!.outcome_tenant_id as string,
        candidateId,
        assignmentId: graph.rows[0]!.outcome_assignment_id as string,
        assignmentGeneration: 1,
        stagedClientReleaseId: stage.rows[0]!.id,
        oauthClientId: client.rows[0]!.id,
        fixtureVersion: "bootstrap-fence",
        fixturePayloadDigest: "4".repeat(64),
        operatorPrincipalDigest: digest(15),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }),
      null
    );
    await pool!.query(
      `UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
       SET state = 'revoked', revoked_at = now() WHERE id = $1`,
      [authorityB!.id]
    );
    await assert.rejects(
      pool!.query(
        `UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
         SET outcome_tenant_id = $1 WHERE id = $2`,
        [graph.rows[0]!.outcome_tenant_id, authorityB!.id]
      ),
      /check constraint|immutable/
    );
    await assert.rejects(
      pool!.query(
        `UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
         SET state = 'active', revoked_at = NULL WHERE id = $1`,
        [authorityB!.id]
      ),
      /immutable/
    );
  });

  it("persists v2 for a bootstrap provision when issuance is enabled", async () => {
    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      const prepared = await prepareBootstrap(94);
      const redeemed = await admitFirstOAuthInviteAtomic(prepared.redeemInput);
      assert.ok(redeemed);
      const operation = await pool!.query<{ provisioner_wire_protocol: string }>(
        "SELECT provisioner_wire_protocol FROM exomem_lifecycle_operations WHERE id = $1",
        [redeemed.operationId]
      );
      assert.deepEqual(operation.rows, [
        { provisioner_wire_protocol: "exomem-cell-provisioner.v2" },
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("resolves an expired strict-v1 reviewer bind target for maintenance and deletion", async () => {
    const prepared = await prepareBootstrap(95);
    const redeemed = await admitFirstOAuthInviteAtomic(prepared.redeemInput);
    assert.ok(redeemed);
    const store = new SqlLifecycleStore();
    const reconciler = new LifecycleReconciler({
      store,
      provisioner: new FakeCellProvisioner(),
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: prepared.fixture.candidate.source_release,
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      envelopeKey: Buffer.alloc(32, 0x95),
      randomBytes: (size) => Buffer.alloc(size, 0x95),
    });
    for (let index = 0; index < 16; index += 1) {
      const result = await reconciler.reconcileOne({
        owner: `expired-reviewer-v1-${index}`,
        tenantId: redeemed.tenantId,
      });
      if (result.kind === "idle") break;
    }

    const bound = await pool!.query<{
      owner_user_id: string;
      bound_cell_id: string;
      target_candidate_id: string;
      target_assignment_id: string;
      target_assignment_generation: string;
      target_source_release: string;
      target_protocol_version: string;
      target_gateway_contract_digest: string;
      target_command_fingerprint: string;
      target_schema_digest: string;
      target_compatibility_digest: string;
    }>(
      `SELECT tenant.owner_user_id::text, tenant.bound_cell_id::text,
              operation.target_candidate_id::text, operation.target_assignment_id::text,
              operation.target_assignment_generation::text, operation.target_source_release,
              operation.target_protocol_version, operation.target_gateway_contract_digest,
              operation.target_command_fingerprint, operation.target_schema_digest,
              operation.target_compatibility_digest
       FROM exomem_tenants AS tenant
       JOIN exomem_lifecycle_operations AS operation ON operation.id = $1
       WHERE tenant.id = $2`,
      [redeemed.operationId, redeemed.tenantId]
    );
    assert.equal(bound.rows.length, 1);
    const target = bound.rows[0]!;
    await pool!.query(
      "UPDATE exomem_agent_contract_rollout_assignments SET state = 'expired', activated_at = NULL, ended_at = now(), version = version + 1, updated_at = now() WHERE id = $1",
      [target.target_assignment_id]
    );
    await pool!.query(
      "UPDATE exomem_agent_contract_candidates SET state = 'retired', promoted_at = COALESCE(promoted_at, now()), retired_at = now() WHERE id = $1",
      [target.target_candidate_id]
    );

    const maintenance = await store.enqueue(
      redeemed.tenantId,
      "suspend",
      "expired-reviewer-v1-maintenance",
      target.bound_cell_id
    );
    assert.deepEqual(maintenance.target, {
      candidateId: target.target_candidate_id,
      assignmentId: target.target_assignment_id,
      assignmentGeneration: Number(target.target_assignment_generation),
      sourceRelease: target.target_source_release,
      protocolVersion: target.target_protocol_version,
      gatewayContractDigest: target.target_gateway_contract_digest,
      commandFingerprint: target.target_command_fingerprint,
      schemaDigest: target.target_schema_digest,
      compatibilityDigest: target.target_compatibility_digest,
    });

    const tokenDigest = digest(95_001);
    assert.ok(
      await createDeletionConfirmationToken({
        userId: target.owner_user_id,
        tenantId: redeemed.tenantId,
        tokenDigest,
        expiresAt: new Date(Date.now() + 60_000),
      })
    );
    const deletion = await consumeDeletionConfirmationAtomic({
      userId: target.owner_user_id,
      tenantId: redeemed.tenantId,
      tokenDigest,
    });
    assert.ok(deletion);
    const deletionTarget = await pool!.query<{
      target_candidate_id: string;
      target_assignment_id: string;
      target_assignment_generation: string;
      target_source_release: string;
      target_protocol_version: string;
      target_gateway_contract_digest: string;
      target_command_fingerprint: string;
      target_schema_digest: string;
      target_compatibility_digest: string;
    }>(
      `SELECT target_candidate_id::text, target_assignment_id::text, target_assignment_generation::text,
              target_source_release, target_protocol_version, target_gateway_contract_digest,
              target_command_fingerprint, target_schema_digest, target_compatibility_digest
       FROM exomem_lifecycle_operations WHERE id = $1`,
      [deletion!.operationId]
    );
    assert.deepEqual(deletionTarget.rows, [
      {
        target_candidate_id: target.target_candidate_id,
        target_assignment_id: target.target_assignment_id,
        target_assignment_generation: target.target_assignment_generation,
        target_source_release: target.target_source_release,
        target_protocol_version: target.target_protocol_version,
        target_gateway_contract_digest: target.target_gateway_contract_digest,
        target_command_fingerprint: target.target_command_fingerprint,
        target_schema_digest: target.target_schema_digest,
        target_compatibility_digest: target.target_compatibility_digest,
      },
    ]);
  });

  it("serializes concurrent authority creation without mutating the losing client", async () => {
    const fixture = await createBootstrapFixture(20);
    const create = () =>
      createReviewerOAuthBootstrapAuthority({
        inviteId: fixture.inviteId,
        stagedClientReleaseId: fixture.stageId,
        oauthClientId: fixture.clientIdRecord,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        operatorPrincipalDigest: digest(2001),
      });
    const settled = await Promise.allSettled([create(), create()]);
    assert.equal(
      settled.filter((result) => result.status === "fulfilled" && result.value !== null).length,
      1
    );
    assert.equal(settled.filter((result) => result.status === "rejected").length, 0);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT state FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE invite_id = $1`,
          [fixture.inviteId]
        )
      ).rows,
      [{ state: "active" }]
    );
    await pool!.query(
      `UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities SET state = 'revoked', revoked_at = now()
       WHERE invite_id = $1`,
      [fixture.inviteId]
    );
  });

  it("serializes authorization and redemption into one complete bootstrap graph", async () => {
    const fixture = await createBootstrapFixture(21);
    const authority = await createReviewerOAuthBootstrapAuthority({
      inviteId: fixture.inviteId,
      stagedClientReleaseId: fixture.stageId,
      oauthClientId: fixture.clientIdRecord,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      operatorPrincipalDigest: digest(2101),
    });
    assert.ok(authority);
    const authorize = (n: number) =>
      createAuthorizationTransaction({
        transactionDigest: digest(2110 + n),
        stateDigest: digest(2120 + n),
        stateEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "iv",
          ciphertext: "cipher",
          tag: "tag",
        },
        formNonceDigest: digest(2130 + n),
        continuationBinding: digest(2140 + n),
        clientId: fixture.clientId,
        redirectUri: fixture.redirectUri,
        resource,
        scopes: ["exomem.read"],
        pkceChallenge: `race-${n}`,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
    const authorizations = await Promise.allSettled([authorize(1), authorize(2)]);
    assert.equal(
      authorizations.filter((result) => result.status === "fulfilled" && result.value).length,
      1
    );
    assert.equal(authorizations.filter((result) => result.status === "rejected").length, 0);
    const transactionRow = await pool!.query<{ transaction_digest: Buffer }>(
      `SELECT transaction_digest FROM exomem_oauth_authorization_transactions
       WHERE reviewer_bootstrap_authority_id = $1`,
      [authority!.id]
    );
    assert.equal(transactionRow.rows.length, 1);
    const txDigest = transactionRow.rows[0]!.transaction_digest;
    const redeem = (n: number) =>
      admitFirstOAuthInviteAtomic({
        inviteDigest: digest(2100),
        transactionDigest: txDigest,
        sessionDigest: digest(2150 + n),
        csrfDigest: digest(2160 + n),
        sessionExpiresAt: new Date(Date.now() + 10 * 60_000),
        codeDigest: digest(2170 + n),
        codeExpiresAt: new Date(Date.now() + 10 * 60_000),
      });
    const redemptions = await Promise.allSettled([redeem(1), redeem(2)]);
    assert.equal(
      redemptions.filter((result) => result.status === "fulfilled" && result.value !== null).length,
      1
    );
    assert.equal(redemptions.filter((result) => result.status === "rejected").length, 0);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT state, count(*)::text AS count FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
        WHERE id = $1 GROUP BY state`,
          [authority!.id]
        )
      ).rows,
      [{ state: "consumed", count: "1" }]
    );
  });

  it("allows dirty reviewer history and blocks each usable Hosted authority independently", async (t) => {
    const create = (fixture: BootstrapFixture, sequence: number) =>
      createReviewerOAuthBootstrapAuthority({
        inviteId: fixture.inviteId,
        stagedClientReleaseId: fixture.stageId,
        oauthClientId: fixture.clientIdRecord,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        operatorPrincipalDigest: digest(sequence),
      });

    await t.test(
      "failed, expired, revoked, and uncredentialed parked history is dirty but harmless",
      async () => {
        await resetDatabase();
        const fixture = await createBootstrapFixture(31);
        await seedDirtyReviewerHistory(fixture);
        const authority = await create(fixture, 3101);
        assert.ok(authority);
        assert.deepEqual(
          (
            await pool!.query(
              `SELECT state, count(*)::int AS count
             FROM exomem_agent_contract_rollout_assignments GROUP BY state ORDER BY state`
            )
          ).rows,
          [
            { state: "expired", count: 1 },
            { state: "failed", count: 1 },
            { state: "preparing", count: 1 },
          ]
        );
        assert.equal(
          await revokeReviewerOAuthBootstrapAuthority({ authorityId: authority.id }),
          true
        );
      }
    );

    await t.test(
      "an unexpired active reviewer assignment blocks without touching the client",
      async () => {
        await resetDatabase();
        const fixture = await createBootstrapFixture(32);
        await seedReviewerTenant(fixture, 321, "active");
        assert.equal(await create(fixture, 3201), null);
        await assertClientUnchanged(fixture);
      }
    );

    await t.test(
      "an authoritative bound and ready reviewer cell blocks without touching the client",
      async () => {
        await resetDatabase();
        const fixture = await createBootstrapFixture(33);
        await seedReviewerTenant(fixture, 331, "failed", { boundReadyCell: true });
        assert.equal(await create(fixture, 3301), null);
        await assertClientUnchanged(fixture);
      }
    );

    await t.test(
      "a valid internal-canary credential blocks without touching the client",
      async () => {
        await resetDatabase();
        const fixture = await createBootstrapFixture(34);
        const reviewer = await seedReviewerTenant(fixture, 341, "preparing");
        await seedInternalCanaryCredential(fixture, reviewer, 341, "valid");
        assert.equal(await create(fixture, 3401), null);
        await assertClientUnchanged(fixture);
      }
    );

    await t.test("a live Hosted cohort blocks without touching the client", async () => {
      await resetDatabase();
      const fixture = await createBootstrapFixture(35);
      await seedLiveCohort();
      assert.equal(
        (await pool!.query("SELECT count(*)::int AS count FROM exomem_hosted_alpha_cohort")).rows[0]
          ?.count,
        1
      );
      assert.equal(await create(fixture, 3501), null);
      await assertClientUnchanged(fixture);
    });
  });

  it("fails closed for every mutable bootstrap input and immutable staged target", async (t) => {
    const immutableStageMutations = [
      {
        label: "stage platform",
        sql: `UPDATE exomem_staged_client_releases
              SET platform = 'openai', registered_app_id_sha256 = repeat('9', 64)
              WHERE id = $1`,
      },
      {
        label: "stage OAuth config",
        sql: `UPDATE exomem_staged_client_releases
              SET oauth_client_config_sha256 = repeat('8', 64) WHERE id = $1`,
      },
      {
        label: "stage contract identity",
        sql: `UPDATE exomem_staged_client_releases
              SET contract_sha256 = repeat('7', 64) WHERE id = $1`,
      },
      {
        label: "stage compatibility identity",
        sql: `UPDATE exomem_staged_client_releases
              SET compatibility_sha256 = repeat('6', 64) WHERE id = $1`,
      },
    ];
    for (const [index, mutation] of immutableStageMutations.entries()) {
      await t.test(`${mutation.label} is rejected by PostgreSQL before redemption`, async () => {
        await resetDatabase();
        const prepared = await prepareBootstrap(40 + index);
        const before = await pool!.query(
          `SELECT platform, registered_app_id_sha256, oauth_client_config_sha256,
                  contract_sha256, compatibility_sha256
           FROM exomem_staged_client_releases WHERE id = $1`,
          [prepared.fixture.stageId]
        );
        await assert.rejects(
          pool!.query(mutation.sql, [prepared.fixture.stageId]),
          (error: unknown) =>
            typeof error === "object" && error !== null && "code" in error && error.code === "P0001"
        );
        assert.deepEqual(
          (
            await pool!.query(
              `SELECT platform, registered_app_id_sha256, oauth_client_config_sha256,
                      contract_sha256, compatibility_sha256
               FROM exomem_staged_client_releases WHERE id = $1`,
              [prepared.fixture.stageId]
            )
          ).rows,
          before.rows
        );
        assert.ok(await admitFirstOAuthInviteAtomic(prepared.redeemInput));
      });
    }

    const mutableCases: Array<{
      label: string;
      mutate: (prepared: Awaited<ReturnType<typeof prepareBootstrap>>) => Promise<void>;
    }> = [
      {
        label: "candidate command fingerprint",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query(
                "UPDATE exomem_agent_contract_candidates SET command_fingerprint = repeat('8', 64) WHERE id = $1",
                [fixture.candidateId]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "candidate compatibility digest",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query(
                "UPDATE exomem_agent_contract_candidates SET compatibility_digest = repeat('7', 64) WHERE id = $1",
                [fixture.candidateId]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "stage lifecycle state",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query(
                "UPDATE exomem_staged_client_releases SET state = 'failed', ended_at = now() WHERE id = $1",
                [fixture.stageId]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "client authority version",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query(
                "UPDATE exomem_oauth_clients SET authority_version = gen_random_uuid() WHERE id = $1",
                [fixture.clientIdRecord]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "client OAuth config",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query(
                "UPDATE exomem_oauth_clients SET oauth_client_config_sha256 = repeat('5', 64) WHERE id = $1",
                [fixture.clientIdRecord]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "client redirect set",
        mutate: async ({ fixture }) => {
          const changedRedirects = JSON.stringify(["http://127.0.0.1:49999/changed"]);
          assert.equal(
            (
              await pool!.query(
                `UPDATE exomem_oauth_clients
                 SET redirect_uris = $1::jsonb,
                     redirect_uris_digest = digest(convert_to($1::jsonb::text, 'utf8'), 'sha256')
                 WHERE id = $2`,
                [changedRedirects, fixture.clientIdRecord]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "disabled client",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query("UPDATE exomem_oauth_clients SET enabled = false WHERE id = $1", [
                fixture.clientIdRecord,
              ])
            ).rowCount,
            1
          );
        },
      },
      {
        label: "consumed invite",
        mutate: async ({ fixture }) => consumeInviteForMutation(fixture, 481),
      },
      {
        label: "revoked invite",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query("UPDATE exomem_invites SET revoked_at = now() WHERE id = $1", [
                fixture.inviteId,
              ])
            ).rowCount,
            1
          );
        },
      },
      {
        label: "expired invite",
        mutate: async ({ fixture }) => {
          assert.equal(
            (
              await pool!.query(
                `UPDATE exomem_invites
                 SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
                 WHERE id = $1`,
                [fixture.inviteId]
              )
            ).rowCount,
            1
          );
        },
      },
      {
        label: "revoked authority",
        mutate: async ({ authority }) => {
          assert.equal(
            await revokeReviewerOAuthBootstrapAuthority({ authorityId: authority.id }),
            true
          );
        },
      },
    ];
    for (const [index, mutation] of mutableCases.entries()) {
      await t.test(`${mutation.label} rejects redemption without a partial graph`, async () => {
        await resetDatabase();
        const prepared = await prepareBootstrap(50 + index);
        await mutation.mutate(prepared);
        await assertRedemptionFailsWithoutGraphMutation(prepared);
      });
    }

    await t.test(
      "authority expiry disables the bootstrap client and rejects redemption",
      async () => {
        await resetDatabase();
        const prepared = await prepareBootstrap(70, 1_500);
        const before = await bootstrapGraphSnapshot();
        await new Promise((resolve) => setTimeout(resolve, 1_600));
        assert.equal(
          await createAuthorizationTransaction({
            transactionDigest: digest(70_020),
            stateDigest: digest(70_021),
            stateEnvelope: {
              version: 1,
              algorithm: "A256GCM",
              iv: "iv",
              ciphertext: "cipher",
              tag: "tag",
            },
            formNonceDigest: digest(70_022),
            continuationBinding: digest(70_023),
            clientId: prepared.fixture.clientId,
            redirectUri: prepared.fixture.redirectUri,
            resource,
            scopes: ["exomem.read"],
            pkceChallenge: "expired-bootstrap",
            expiresAt: new Date(Date.now() + 10 * 60_000),
          }),
          null
        );
        assert.deepEqual(
          (
            await pool!.query(
              `SELECT authority.state, client.enabled
             FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
             JOIN exomem_oauth_clients AS client ON client.id = authority.oauth_client_id
             WHERE authority.id = $1`,
              [prepared.authority.id]
            )
          ).rows,
          [{ state: "expired", enabled: false }]
        );
        assert.equal(await admitFirstOAuthInviteAtomic(prepared.redeemInput), null);
        assert.deepEqual(await bootstrapGraphSnapshot(), before);
      }
    );
  });

  it("rolls capacity failure back completely and accepts the exact same inputs after capacity returns", async () => {
    const prepared = await prepareBootstrap(80);
    await setCapacity(0);
    const emptyGraph = {
      users: "0",
      tenants: "0",
      entitlements: "0",
      assignments: "0",
      operations: "0",
      allocations: "0",
      sessions: "0",
      grants: "0",
      codes: "0",
      families: "0",
      access_tokens: "0",
      refresh_tokens: "0",
      reserved_storage_bytes: "0",
      reserved_runtime_slots: "0",
      reserved_provision_slots: "0",
    };
    assert.deepEqual(await bootstrapGraphSnapshot(), emptyGraph);
    await assert.rejects(
      admitFirstOAuthInviteAtomic(prepared.redeemInput),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CAPACITY_UNAVAILABLE"
    );
    assert.deepEqual(await bootstrapGraphSnapshot(), emptyGraph);
    await assertBootstrapReusable(prepared);

    await setCapacity(1);
    const redeemed = await admitFirstOAuthInviteAtomic(prepared.redeemInput);
    assert.ok(redeemed);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT invite.consumed_at IS NOT NULL AS invite_consumed,
                  transaction.consumed_at IS NOT NULL AS transaction_consumed,
                  authority.state AS authority_state,
                  authority.outcome_tenant_id = $2::uuid AS exact_tenant,
                  authority.outcome_operation_id = $3::uuid AS exact_operation
           FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
           JOIN exomem_invites AS invite ON invite.id = authority.invite_id
           JOIN exomem_oauth_authorization_transactions AS transaction
             ON transaction.reviewer_bootstrap_authority_id = authority.id
           WHERE authority.id = $1`,
          [prepared.authority.id, redeemed.tenantId, redeemed.operationId]
        )
      ).rows,
      [
        {
          invite_consumed: true,
          transaction_consumed: true,
          authority_state: "consumed",
          exact_tenant: true,
          exact_operation: true,
        },
      ]
    );
  });

  it("rejects redemption begun before expiry when the cohort lock is acquired after expiry", async () => {
    const prepared = await prepareBootstrap(79, 2_500);
    const before = await bootstrapGraphSnapshot();
    const blocker = await pool!.connect();
    let redemption: Promise<Awaited<ReturnType<typeof admitFirstOAuthInviteAtomic>>> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      redemption = admitFirstOAuthInviteAtomic(prepared.redeemInput);
      await waitForCohortLockWaiters();
      assert.equal(
        (
          await pool!.query<{ unexpired: boolean }>(
            `SELECT clock_timestamp() < expires_at AS unexpired
             FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE id = $1`,
            [prepared.authority.id]
          )
        ).rows[0]?.unexpired,
        true
      );
      await waitForAuthorityWallExpiry(prepared.authority.id);
      await blocker.query("COMMIT");
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
    assert.equal(await redemption!, null);
    assert.deepEqual(await bootstrapGraphSnapshot(), before);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT authority.state, client.enabled,
                  invite.consumed_at AS invite_consumed_at,
                  transaction.consumed_at AS transaction_consumed_at
           FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
           JOIN exomem_oauth_clients AS client ON client.id = authority.oauth_client_id
           JOIN exomem_invites AS invite ON invite.id = authority.invite_id
           JOIN exomem_oauth_authorization_transactions AS transaction
             ON transaction.reviewer_bootstrap_authority_id = authority.id
           WHERE authority.id = $1`,
          [prepared.authority.id]
        )
      ).rows,
      [
        {
          state: "expired",
          enabled: false,
          invite_consumed_at: null,
          transaction_consumed_at: null,
        },
      ]
    );
  });

  it("serializes a queued revocation winner ahead of a concurrent redemption", async () => {
    const prepared = await prepareBootstrap(80);
    const before = await bootstrapGraphSnapshot();
    const blocker = await pool!.connect();
    let revocation: Promise<boolean> | undefined;
    let redemption: Promise<Awaited<ReturnType<typeof admitFirstOAuthInviteAtomic>>> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      revocation = revokeReviewerOAuthBootstrapAuthority({ authorityId: prepared.authority.id });
      await waitForCohortLockWaiters();
      redemption = admitFirstOAuthInviteAtomic(prepared.redeemInput);
      await waitForCohortLockWaiters(2);
      await blocker.query("COMMIT");
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
    const [revoked, redeemed] = await Promise.all([revocation!, redemption!]);
    assert.equal(revoked, true);
    assert.equal(redeemed, null);
    assert.deepEqual(await bootstrapGraphSnapshot(), before);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT authority.state, client.enabled,
                  invite.consumed_at AS invite_consumed_at,
                  transaction.consumed_at AS transaction_consumed_at
           FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
           JOIN exomem_oauth_clients AS client ON client.id = authority.oauth_client_id
           JOIN exomem_invites AS invite ON invite.id = authority.invite_id
           JOIN exomem_oauth_authorization_transactions AS transaction
             ON transaction.reviewer_bootstrap_authority_id = authority.id
           WHERE authority.id = $1`,
          [prepared.authority.id]
        )
      ).rows,
      [
        {
          state: "revoked",
          enabled: false,
          invite_consumed_at: null,
          transaction_consumed_at: null,
        },
      ]
    );
  });

  it("loses a concurrent final-capacity race without mutation and retries exact inputs", async () => {
    const prepared = await prepareBootstrap(81);
    await setCapacity(1);
    const capacityWinner = await pool!.connect();
    let redemption: Promise<Awaited<ReturnType<typeof admitFirstOAuthInviteAtomic>>> | undefined;
    try {
      await capacityWinner.query("BEGIN");
      await capacityWinner.query(
        `SELECT id FROM exomem_capacity_pools
         WHERE pool_key = 'exomem-hosted-alpha' FOR UPDATE`
      );
      redemption = admitFirstOAuthInviteAtomic(prepared.redeemInput);
      await waitForBlockedQuery("%UPDATE exomem_capacity_pools AS pool%reserved_storage_bytes%");
      const wonCapacity = await capacityWinner.query(
        `UPDATE exomem_capacity_pools
         SET reserved_storage_bytes = reserved_storage_bytes + $1,
             reserved_runtime_slots = reserved_runtime_slots + 1,
             reserved_provision_slots = reserved_provision_slots + 1,
             updated_at = clock_timestamp()
         WHERE pool_key = 'exomem-hosted-alpha'
           AND storage_capacity_bytes >= reserved_storage_bytes + $1
           AND runtime_capacity_slots >= reserved_runtime_slots + 1
           AND provision_reservation_capacity >= reserved_provision_slots + 1
         RETURNING id`,
        [EXOMEM_ALPHA_CAPACITY.storageBytes]
      );
      assert.equal(wonCapacity.rowCount, 1);
      await capacityWinner.query("COMMIT");
    } catch (error) {
      await capacityWinner.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      capacityWinner.release();
    }
    await assert.rejects(
      redemption!,
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CAPACITY_UNAVAILABLE"
    );
    assert.deepEqual(await bootstrapGraphSnapshot(), {
      users: "0",
      tenants: "0",
      entitlements: "0",
      assignments: "0",
      operations: "0",
      allocations: "0",
      sessions: "0",
      grants: "0",
      codes: "0",
      families: "0",
      access_tokens: "0",
      refresh_tokens: "0",
      reserved_storage_bytes: String(EXOMEM_ALPHA_CAPACITY.storageBytes),
      reserved_runtime_slots: "1",
      reserved_provision_slots: "1",
    });
    await assertBootstrapReusable(prepared);

    await setCapacity(1);
    assert.ok(await admitFirstOAuthInviteAtomic(prepared.redeemInput));
  });

  it("serializes a candidate promotion winner ahead of redemption without a partial graph", async () => {
    const prepared = await prepareBootstrap(82);
    const before = await bootstrapGraphSnapshot();
    const promoter = await pool!.connect();
    let redemption: Promise<Awaited<ReturnType<typeof admitFirstOAuthInviteAtomic>>> | undefined;
    try {
      await promoter.query("BEGIN");
      await promoter.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      assert.equal(
        (
          await promoter.query(
            `UPDATE exomem_agent_contract_candidates
             SET state = 'live', promoted_at = now() WHERE id = $1 AND state = 'pending'`,
            [prepared.fixture.candidateId]
          )
        ).rowCount,
        1
      );
      redemption = admitFirstOAuthInviteAtomic(prepared.redeemInput);
      await waitForCohortLockWaiters();
      await promoter.query("COMMIT");
    } catch (error) {
      await promoter.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      promoter.release();
    }
    assert.equal(await redemption!, null);
    assert.deepEqual(await bootstrapGraphSnapshot(), before);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT candidate.state, authority.state AS authority_state,
                  invite.consumed_at AS invite_consumed_at,
                  transaction.consumed_at AS transaction_consumed_at
           FROM exomem_agent_contract_candidates AS candidate
           JOIN exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
             ON authority.candidate_id = candidate.id
           JOIN exomem_invites AS invite ON invite.id = authority.invite_id
           JOIN exomem_oauth_authorization_transactions AS transaction
             ON transaction.reviewer_bootstrap_authority_id = authority.id
           WHERE candidate.id = $1`,
          [prepared.fixture.candidateId]
        )
      ).rows,
      [
        {
          state: "live",
          authority_state: "active",
          invite_consumed_at: null,
          transaction_consumed_at: null,
        },
      ]
    );
  });

  it("claims the committed operation immediately with the exact 0.50.0 assignment target", async () => {
    const prepared = await prepareBootstrap(83);
    const redeemed = await admitFirstOAuthInviteAtomic(prepared.redeemInput);
    assert.ok(redeemed);

    const fallbackCandidateId = await storeRetainedExomemAgentContractCandidate("0.34.0");
    assert.equal(
      (
        await pool!.query(
          `UPDATE exomem_agent_contract_candidates
           SET state = 'live', promoted_at = now() WHERE id = $1 AND state = 'pending'`,
          [fallbackCandidateId]
        )
      ).rowCount,
      1
    );
    const claimed = await new SqlLifecycleStore().claim({
      owner: "bootstrap-immediate-claimer",
      leaseMs: 60_000,
      maxAttempts: 3,
      tenantId: redeemed.tenantId,
    });
    assert.ok(claimed);
    assert.equal(claimed.id, redeemed.operationId);
    assert.equal(claimed.provisionerWireProtocol, "exomem-cell-provisioner.v1");
    assert.deepEqual(claimed.target, {
      candidateId: prepared.fixture.candidateId,
      assignmentId: (
        await pool!.query<{ outcome_assignment_id: string }>(
          `SELECT outcome_assignment_id FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
           WHERE id = $1`,
          [prepared.authority.id]
        )
      ).rows[0]!.outcome_assignment_id,
      assignmentGeneration: 1,
      sourceRelease: prepared.fixture.candidate.source_release,
      protocolVersion: prepared.fixture.candidate.protocol_version,
      gatewayContractDigest: exomemContractFixture0500.digest,
      commandFingerprint: prepared.fixture.candidate.command_fingerprint,
      schemaDigest: prepared.fixture.candidate.schema_digest,
      compatibilityDigest: prepared.fixture.candidate.compatibility_digest,
    });
    assert.notEqual(claimed.target?.candidateId, fallbackCandidateId);
  });

  it("seals setup OAuth on exact credential issuance and exchanges only a fresh attributed code", async () => {
    const prepared = await prepareBootstrap(90);
    const redeemed = await admitFirstOAuthInviteAtomic(prepared.redeemInput);
    assert.ok(redeemed);
    const outcome = (
      await pool!.query<{
        outcome_tenant_id: string;
        outcome_assignment_id: string;
        outcome_assignment_generation: string;
        outcome_session_id: string;
        outcome_grant_id: string;
      }>(
        `SELECT outcome_tenant_id, outcome_assignment_id, outcome_assignment_generation,
                outcome_session_id, outcome_grant_id
         FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE id = $1`,
        [prepared.authority.id]
      )
    ).rows[0]!;

    assert.equal(
      await issueOAuthTokensFromCodeAtomic({
        codeDigest: prepared.redeemInput.codeDigest,
        clientId: prepared.fixture.clientId,
        redirectUri: prepared.fixture.redirectUri,
        resource,
        pkceChallenge: "bootstrap-90",
        refreshDigest: digest(90_020),
        refreshExpiresAt: new Date(Date.now() + 10 * 60_000),
        accessDigest: digest(90_021),
        accessExpiresAt: new Date(Date.now() + 10 * 60_000),
      }),
      null
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT code.consumed_at,
                  (SELECT count(*)::int FROM exomem_oauth_token_families) AS families,
                  (SELECT count(*)::int FROM exomem_oauth_access_tokens) AS access_tokens,
                  (SELECT count(*)::int FROM exomem_oauth_refresh_tokens) AS refresh_tokens
           FROM exomem_oauth_authorization_codes AS code
           WHERE code.code_digest = $1`,
          [prepared.redeemInput.codeDigest]
        )
      ).rows,
      [{ consumed_at: null, families: 0, access_tokens: 0, refresh_tokens: 0 }]
    );

    const parked = await seedReviewerTenant(prepared.fixture, 901, "preparing");
    const unrelatedCredentialInput = {
      platform: "claude" as const,
      usernameDigest: digest(90_030),
      passwordHash: "$argon2id$unrelated-parked",
      tenantId: parked.tenantId,
      candidateId: prepared.fixture.candidateId,
      assignmentId: parked.assignmentId,
      assignmentGeneration: parked.assignmentGeneration,
      stagedClientReleaseId: prepared.fixture.stageId,
      oauthClientId: prepared.fixture.clientIdRecord,
      fixtureVersion: "unrelated-parked",
      fixturePayloadDigest: "4".repeat(64),
      operatorPrincipalDigest: digest(90_031),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    };
    assert.equal(
      await createInternalCanaryReviewerCredentialAtomic(unrelatedCredentialInput),
      null
    );

    const siblingClientId = "exact-bootstrap-promotion-sibling";
    const siblingRedirectUri = "http://127.0.0.1:47990/callback";
    const siblingConfig = oauthClientConfigSha256({
      platform: "claude",
      admissionMode: "pinned",
      clientId: siblingClientId,
      redirectUris: [siblingRedirectUri],
    });
    const siblingStage = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_staged_client_releases (
         candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest, expires_at
       ) VALUES ($1, 'claude', 'staged', $2, $3, $4, $5, '0.1.0', $6, $7, now() + interval '20 minutes')
       RETURNING id`,
      [
        prepared.fixture.candidateId,
        "a".repeat(64),
        "b".repeat(64),
        prepared.fixture.candidate.compatibility_digest,
        prepared.fixture.candidate.schema_digest,
        siblingConfig,
        digest(90_039).toString("hex"),
      ]
    );
    const siblingClient = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_platform,
         oauth_client_config_sha256
       ) VALUES ($1, 'pinned', true, $2::jsonb,
         digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'), 'claude', $3) RETURNING id`,
      [siblingClientId, JSON.stringify([siblingRedirectUri]), siblingConfig]
    );

    const exactCredential = await createInternalCanaryReviewerCredentialAtomic({
      platform: "claude",
      usernameDigest: digest(90_040),
      passwordHash: "$argon2id$exact-bootstrap",
      tenantId: outcome.outcome_tenant_id,
      candidateId: prepared.fixture.candidateId,
      assignmentId: outcome.outcome_assignment_id,
      assignmentGeneration: Number(outcome.outcome_assignment_generation),
      stagedClientReleaseId: siblingStage.rows[0]!.id,
      oauthClientId: siblingClient.rows[0]!.id,
      fixtureVersion: "exact-bootstrap",
      fixturePayloadDigest: "5".repeat(64),
      operatorPrincipalDigest: digest(90_041),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.ok(exactCredential);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT session.revoked_at IS NOT NULL AS session_revoked,
                  grant_row.revoked_at IS NOT NULL AS grant_revoked,
                  code.consumed_at IS NOT NULL AS code_consumed
           FROM exomem_sessions AS session
           JOIN exomem_oauth_grants AS grant_row ON grant_row.id = $2::uuid
           JOIN exomem_oauth_authorization_codes AS code ON code.grant_id = grant_row.id
           WHERE session.id = $1::uuid`,
          [outcome.outcome_session_id, outcome.outcome_grant_id]
        )
      ).rows,
      [{ session_revoked: true, grant_revoked: true, code_consumed: true }]
    );
    assert.equal(
      await createInternalCanaryReviewerCredentialAtomic({
        ...unrelatedCredentialInput,
        usernameDigest: digest(90_032),
      }),
      null
    );

    const cell = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version,
         release_version, readiness_code
       ) VALUES ($1, 'active', 'bound', 'running', $2, $3, 'CELL_READY') RETURNING id`,
      [
        outcome.outcome_tenant_id,
        prepared.fixture.candidate.protocol_version,
        prepared.fixture.candidate.source_release,
      ]
    );
    await pool!.query(
      `UPDATE exomem_tenants
       SET bound_cell_id = $1, status = 'active', desired_state = 'running' WHERE id = $2`,
      [cell.rows[0]!.id, outcome.outcome_tenant_id]
    );
    await pool!.query(
      `UPDATE exomem_agent_contract_rollout_assignments
       SET state = 'active', activated_at = now(), ended_at = NULL, updated_at = now()
       WHERE id = $1`,
      [outcome.outcome_assignment_id]
    );
    await pool!.query(
      `UPDATE exomem_staged_client_releases
       SET state = 'evidenced', evidenced_at = now(), ended_at = NULL, updated_at = now()
       WHERE id = $1`,
      [siblingStage.rows[0]!.id]
    );

    const freshTransactionDigest = digest(90_050);
    assert.ok(
      await createAuthorizationTransaction({
        transactionDigest: freshTransactionDigest,
        stateDigest: digest(90_051),
        stateEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "fresh-iv",
          ciphertext: "fresh-cipher",
          tag: "fresh-tag",
        },
        formNonceDigest: digest(90_052),
        continuationBinding: digest(90_053),
        clientId: siblingClientId,
        redirectUri: siblingRedirectUri,
        resource,
        scopes: ["exomem.read", "offline_access"],
        pkceChallenge: "fresh-bootstrap-credential",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      })
    );
    const freshSession = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: exactCredential.credentialId,
      transactionDigest: freshTransactionDigest,
      sessionDigest: digest(90_054),
      csrfDigest: digest(90_055),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.ok(freshSession);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT transaction.candidate_id::text, transaction.assignment_id::text,
                  transaction.assignment_generation::text,
                  transaction.staged_client_release_id::text,
                  transaction.reviewer_credential_id::text,
                  session.candidate_id::text AS session_candidate_id,
                  session.assignment_id::text AS session_assignment_id,
                  session.assignment_generation::text AS session_assignment_generation,
                  session.staged_client_release_id::text AS session_stage_id,
                  session.reviewer_credential_id::text AS session_credential_id
           FROM exomem_oauth_authorization_transactions AS transaction
           JOIN exomem_sessions AS session ON session.id = $2::uuid
           WHERE transaction.transaction_digest = $1`,
          [freshTransactionDigest, freshSession.sessionId]
        )
      ).rows,
      [
        {
          candidate_id: prepared.fixture.candidateId,
          assignment_id: outcome.outcome_assignment_id,
          assignment_generation: outcome.outcome_assignment_generation,
          staged_client_release_id: siblingStage.rows[0]!.id,
          reviewer_credential_id: exactCredential.credentialId,
          session_candidate_id: prepared.fixture.candidateId,
          session_assignment_id: outcome.outcome_assignment_id,
          session_assignment_generation: outcome.outcome_assignment_generation,
          session_stage_id: siblingStage.rows[0]!.id,
          session_credential_id: exactCredential.credentialId,
        },
      ]
    );

    const freshCodeDigest = digest(90_060);
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: freshSession.sessionId,
      transactionDigest: freshTransactionDigest,
      codeDigest: freshCodeDigest,
      codeExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.ok(attached);
    const tokenContext = await issueOAuthTokensFromCodeAtomic({
      codeDigest: freshCodeDigest,
      clientId: siblingClientId,
      redirectUri: siblingRedirectUri,
      resource,
      pkceChallenge: "fresh-bootstrap-credential",
      refreshDigest: digest(90_061),
      refreshExpiresAt: new Date(Date.now() + 10 * 60_000),
      accessDigest: digest(90_062),
      accessExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    assert.ok(tokenContext);
    assert.equal(tokenContext.refreshInserted, true);
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT access.candidate_id::text, access.assignment_id::text,
                  access.assignment_generation::text,
                  access.staged_client_release_id::text,
                  access.reviewer_credential_id::text,
                  code.consumed_at IS NOT NULL AS code_consumed
           FROM exomem_oauth_access_tokens AS access
           JOIN exomem_oauth_authorization_codes AS code ON code.code_digest = $1
           WHERE access.access_digest = $2`,
          [freshCodeDigest, digest(90_062)]
        )
      ).rows,
      [
        {
          candidate_id: prepared.fixture.candidateId,
          assignment_id: outcome.outcome_assignment_id,
          assignment_generation: outcome.outcome_assignment_generation,
          staged_client_release_id: siblingStage.rows[0]!.id,
          reviewer_credential_id: exactCredential.credentialId,
          code_consumed: true,
        },
      ]
    );
  });

  it("issues exact Claude and OpenAI sibling credentials after bootstrap consumption", async () => {
    const prepared = await prepareBootstrap(91);
    const redeemed = await admitFirstOAuthInviteAtomic(prepared.redeemInput);
    assert.ok(redeemed);
    const outcome = (
      await pool!.query<{
        outcome_tenant_id: string;
        outcome_assignment_id: string;
        outcome_assignment_generation: string;
      }>(
        `SELECT outcome_tenant_id, outcome_assignment_id, outcome_assignment_generation
         FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities WHERE id = $1`,
        [prepared.authority.id]
      )
    ).rows[0]!;
    assert.deepEqual(
      (
        await pool!.query("SELECT state FROM exomem_staged_client_releases WHERE id = $1", [
          prepared.fixture.stageId,
        ])
      ).rows,
      [{ state: "failed" }]
    );
    const sibling = async (platform: "claude" | "openai", suffix: number) => {
      const clientId = `promotion-sibling-${platform}-${suffix}`;
      const redirectUri = `http://127.0.0.1:${49000 + suffix}/callback`;
      const config = oauthClientConfigSha256({
        platform,
        admissionMode: "pinned",
        clientId,
        redirectUris: [redirectUri],
      });
      const stage = await pool!.query<{ id: string }>(
        `INSERT INTO exomem_staged_client_releases (
           candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
           contract_sha256, plugin_version, oauth_client_config_sha256, registered_app_id_sha256,
           created_by_principal_digest, expires_at
         ) VALUES ($1, $2, 'staged', $3, $4, $5, $6, '0.1.0', $7, $8, $9, now() + interval '20 minutes')
         RETURNING id`,
        [
          prepared.fixture.candidateId,
          platform,
          "a".repeat(64),
          "b".repeat(64),
          prepared.fixture.candidate.compatibility_digest,
          prepared.fixture.candidate.schema_digest,
          config,
          platform === "openai" ? "c".repeat(64) : null,
          digest(91_100 + suffix).toString("hex"),
        ]
      );
      const client = await registerOperatorOAuthClient({
        admissionMode: "pinned",
        platform,
        stagedClientReleaseId: stage.rows[0]!.id,
        clientId,
        redirectUris: [redirectUri],
        ...(platform === "openai" ? { registeredAppIdSha256: "c".repeat(64) } : {}),
      });
      assert.equal(client.enabled, false);
      return { stageId: stage.rows[0]!.id, clientId: client.id };
    };
    const claude = await sibling("claude", 1);
    const openai = await sibling("openai", 2);
    const base = {
      tenantId: outcome.outcome_tenant_id,
      candidateId: prepared.fixture.candidateId,
      assignmentId: outcome.outcome_assignment_id,
      assignmentGeneration: Number(outcome.outcome_assignment_generation),
      passwordHash: "$argon2id$fresh-promotion-sibling",
      fixtureVersion: "fresh-promotion-sibling",
      fixturePayloadDigest: "d".repeat(64),
      operatorPrincipalDigest: digest(91_200),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    };
    assert.ok(
      await createInternalCanaryReviewerCredentialAtomic({
        ...base,
        platform: "claude",
        usernameDigest: digest(91_201),
        stagedClientReleaseId: claude.stageId,
        oauthClientId: claude.clientId,
      })
    );
    assert.ok(
      await createInternalCanaryReviewerCredentialAtomic({
        ...base,
        platform: "openai",
        usernameDigest: digest(91_202),
        stagedClientReleaseId: openai.stageId,
        oauthClientId: openai.clientId,
      })
    );
    const mismatchedCandidateId = await storeRetainedExomemAgentContractCandidate("0.34.0");
    await pool!.query(
      `ALTER TABLE exomem_marketplace_reviewer_oauth_bootstrap_authorities
       DISABLE TRIGGER exomem_marketplace_reviewer_oauth_bootstrap_immutable`
    );
    await pool!.query(
      `UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
       SET candidate_id = $2::uuid
       WHERE id = $1::uuid`,
      [prepared.authority.id, mismatchedCandidateId]
    );
    await pool!.query(
      `ALTER TABLE exomem_marketplace_reviewer_oauth_bootstrap_authorities
       ENABLE TRIGGER exomem_marketplace_reviewer_oauth_bootstrap_immutable`
    );
    await pool!.query(
      `UPDATE exomem_staged_client_releases
       SET state = 'failed', ended_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1::uuid`,
      [claude.stageId]
    );
    const mismatched = await sibling("claude", 3);
    assert.equal(
      await createInternalCanaryReviewerCredentialAtomic({
        ...base,
        platform: "claude",
        usernameDigest: digest(91_203),
        stagedClientReleaseId: mismatched.stageId,
        oauthClientId: mismatched.clientId,
      }),
      null
    );
    assert.equal(
      await createInternalCanaryReviewerCredentialAtomic({
        ...base,
        platform: "claude",
        usernameDigest: digest(91_204),
        stagedClientReleaseId: prepared.fixture.stageId,
        oauthClientId: prepared.fixture.clientIdRecord,
      }),
      null
    );
    assert.deepEqual(
      (
        await pool!.query(
          `SELECT client_id, enabled, reviewer_bootstrap_ever_authorized
           FROM exomem_oauth_clients WHERE id = $1`,
          [prepared.fixture.clientIdRecord]
        )
      ).rows,
      [
        {
          client_id: prepared.fixture.clientId,
          enabled: false,
          reviewer_bootstrap_ever_authorized: true,
        },
      ]
    );
  });
});
