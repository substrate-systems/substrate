import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { EXOMEM_ALPHA_CAPACITY } from "../oauth-admission";
import { ExomemHostedError } from "../errors";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  admitFirstOAuthInviteAtomic,
  attachExistingOwnerAuthorizationAtomic,
  findActiveOAuthAccessToken,
  findMcpOAuthAccessToken,
  issueOAuthTokensFromCodeAtomic,
  pruneExpiredOAuthState,
  resolveApprovedOAuthClient,
  revokeOAuthAccountForOwnerTenantAtomic,
  revokeOAuthTokenForClient,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";
import { oauthClientConfigSha256 } from "../oauth-client-admission";
import { registerOperatorOAuthClient, setOperatorOAuthClientEnabled } from "../operator-controls";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "https://client.example.test/metadata.json";
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
let pool: Pool | undefined;
let schema: string | undefined;
let transactionApplicationName: string | undefined;

function digest(value: number): Buffer {
  return Buffer.alloc(32, value);
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

async function seedInviteAndTransaction(clientInternalId: string, suffix: string): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, 'complimentary', '[]'::jsonb, '{}'::jsonb, $3, now() + interval '1 hour')`,
    [digest(Number(suffix)), `invite-${suffix}@example.test`, digest(90)]
  );
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, pkce_challenge, expires_at
     ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
       ARRAY['exomem.read', 'offline_access'], $4, 'challenge', now() + interval '1 hour')`,
    [digest(Number(suffix) + 20), clientInternalId, resource, digest(80)]
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
       state_digest, pkce_challenge, expires_at
     ) VALUES ($1, $2, 'https://client.example.test/callback', $3,
       ARRAY['exomem.read'], $4, 'challenge', now() + interval '1 hour')`,
    [digest(sequence + 20), clientInternalId, resource, digest(sequence + 2)]
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
  offlineAccess: boolean
) {
  const codeDigest = digest(sequence);
  const user = await pool!.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `oauth-${sequence}-${randomUUID()}@example.test`,
  ]);
  const tenant = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [user.rows[0].id]
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

describe("OAuth admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `oauth_it_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    await applyMigrations({ databaseUrl: scoped.toString() });
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
      `INSERT INTO exomem_oauth_authorization_transactions (transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest, pkce_challenge, expires_at)
       VALUES ($1, $2, 'https://client.example.test/callback', $3, ARRAY['exomem.read'], $4, 'challenge', now() + interval '1 hour')`,
      [digest(32), internal, resource, digest(33)]
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

  it("rejects a soft-deleted identity without changing capacity or consuming its invite", async () => {
    const internal = await seedClient();
    await seedPool();
    await pool!.query(
      "INSERT INTO users (email, deleted_at) VALUES ('deleted-owner@example.test', now())"
    );
    await seedAdmission(internal, 230, "deleted-owner@example.test");
    assert.equal(await admitFirstOAuthInviteAtomic(admissionInput(230)), null);
    assert.equal(await scalar("SELECT count(*) FROM exomem_capacity_allocations"), 0);
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

  it("fails authorization client resolution closed when either live artifact no longer matches", async () => {
    await seedClient();
    assert.ok(await resolveApprovedOAuthClient(clientId));
    await pool!.query(
      "UPDATE exomem_client_artifacts SET state = 'retired', retired_at = now() WHERE platform = 'openai'"
    );
    assert.equal(await resolveApprovedOAuthClient(clientId), null);
    await pool!.query(
      "UPDATE exomem_client_artifacts SET state = 'live', retired_at = NULL WHERE platform = 'openai'"
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

  it("waits for artifact demotion before taking the cohort authorization snapshot", async () => {
    await seedClient();
    const lock = await pool!.connect();
    const applicationName = `exomem-oauth-cohort-${randomUUID()}`;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      await lock.query(
        "UPDATE exomem_client_artifacts SET state = 'retired', retired_at = now() WHERE platform = 'openai'"
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
        "UPDATE exomem_client_artifacts SET state = 'live', retired_at = NULL WHERE platform = 'openai'"
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
});
