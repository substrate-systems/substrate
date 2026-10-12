import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { admitFirstCloudOAuthInviteAtomic, randomCloudCellId } from "../cloud-admission";
import { findCloudOAuthAccessToken, resolveApprovedCloudOAuthClient } from "../cloud-oauth";
import { ExomemHostedError } from "../errors";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  attachExistingOwnerAuthorizationAtomic,
  createAuthorizationTransaction,
  findPendingOAuthAuthorization,
  issueOAuthTokensFromCodeAtomic,
  pruneExpiredOAuthState,
  registerAdmittedCimdClient,
  registerGenericMcpClient,
  revokeOAuthAccountForOwnerTenantAtomic,
  revokeOAuthTokenForClient,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";
import {
  createOAuthContinuation,
  resolveOAuthContinuationToken,
  validateOAuthContinuationNonce,
} from "../oauth-continuity";
import { oauthClientConfigSha256 } from "../oauth-client-admission";
import { EXOMEM_RATE_LIMITS } from "../rate-limit";
import type { SecretEnvelope } from "../security";
import {
  refreshOperatorCimdOAuthClient,
  registerOperatorOAuthClient,
  setOperatorOAuthClientEnabled,
} from "../operator-controls";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "https://client.example.test/metadata.json";
const resource = "https://gateway.example.test/mcp";
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

async function scalar(query: string, values: unknown[] = []): Promise<number> {
  const result = await pool!.query(query, values);
  return Number(result.rows[0]?.count ?? 0);
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
       'live', 'hosted-alpha-agent-v4', $1, 'test', $2, $3, $4, '1', '["2025-11-25"]'::jsonb, '{}'::jsonb,
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

describe("OAuth admission PostgreSQL integration", { skip: !databaseUrl, concurrency: false }, () => {
  before(async () => {
    // The token store binds Cloud reviewer authority to the configured Cloud resource.
    process.env.EXOMEM_CLOUD_MCP_URL = resource;
    process.env.EXOMEM_CLOUD_MCP_PATH = "/mcp";
    schema = `oauth_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
    await seedLiveCohort();
  });

  after(async () => {
    delete process.env.EXOMEM_CLOUD_MCP_URL;
    delete process.env.EXOMEM_CLOUD_MCP_PATH;
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
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

  it("admits a registered client without binding its service policy to an artifact", async () => {
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
    assert.ok(await resolveApprovedCloudOAuthClient(admittedClientId));
    await pool!.query(
      "UPDATE exomem_oauth_clients SET oauth_client_config_sha256 = $1 WHERE id = $2",
      ["0".repeat(64), registered.id]
    );
    assert.ok(await resolveApprovedCloudOAuthClient(admittedClientId));
    await pool!.query(
      "UPDATE exomem_client_artifacts SET oauth_client_config_sha256 = $1 WHERE id = $2",
      ["f".repeat(64), artifact.rows[0]!.id]
    );
  });

  // Deliberately never restates the bound. It used to assert 32 in three places,
  // which meant raising it in the database would have been reported as a broken
  // test rather than as the intended change. The canonical source is
  // exomem_oauth_client_partition_available itself, so this fills until that
  // predicate says the operator partition is full and works at any bound.
  it("keeps the operator admission bound under concurrent registration and permits an existing client at capacity", async () => {
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

      // Fill until the canonical predicate says the operator partition is full,
      // rather than counting up to a number restated here. `probe` is an id that
      // does not exist, so the predicate's EXISTS shortcut cannot mask the count.
      const probe = `https://oauth-capacity-probe.example.test/${randomUUID()}`;
      const operatorSlotFree = async (): Promise<boolean> =>
        (
          await pool!.query<{ allowed: boolean }>(
            "SELECT exomem_oauth_client_partition_available($1, false) AS allowed",
            [probe]
          )
        ).rows[0]!.allowed;
      const fillerIds: string[] = [];
      while (await operatorSlotFree()) {
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
        fillerIds.push(fillerClientId);
      }
      const boundedCount = await scalar("SELECT count(*) FROM exomem_oauth_clients");
      // Give back exactly one slot, so the two concurrent registrations below are
      // racing for a single opening whatever the bound happens to be.
      assert.ok(fillerIds.length > 0, "the partition was already full before filling");
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [
        fillerIds[fillerIds.length - 1],
      ]);
      assert.equal(await operatorSlotFree(), true);

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
      assert.equal(await scalar("SELECT count(*) FROM exomem_oauth_clients"), boundedCount);

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
          return { ...cimdMetadata(cimdClientId, redirectUris, "stale"), clientName: "Stale name" };
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
        {
          fetchCimd: async () => ({
            ...cimdMetadata(cimdClientId, redirectUris, "newer"),
            clientName: "Operator connector",
          }),
        }
      );
      const newer = await pool!.query(
        `SELECT enabled, authority_version::text, encode(metadata_document_digest, 'hex') AS metadata_digest,
                redirect_uris::text, metadata_provenance::text, client_name
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
                redirect_uris::text, metadata_provenance::text, client_name
         FROM exomem_oauth_clients WHERE id = $1`,
        [registered.id]
      );
      assert.equal(newer.rows[0].enabled, false);
      assert.equal(newer.rows[0].client_name, "Operator connector");
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

  it("registers a native client's loopback document and continues on any port", async () => {
      // Claude Code's real document lists two portless loopback redirects and calls
      // back on whatever port is free (RFC 8252 §7.3, substrate#188).
      const host = "connector-native.example.test";
      const nativeId = `https://${host}/oauth/${randomUUID()}/client.json`;
      const mixedId = `https://${host}/oauth/${randomUUID()}/client.json`;
      const loopback = ["http://localhost/callback", "http://127.0.0.1/callback"];
      const previousKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
      process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 9).toString("base64url");
      await pool!.query(
        "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        ["claude", host]
      );
      try {
        const registered = await registerAdmittedCimdClient(nativeId, {
          fetchCimd: async () => cimdMetadata(nativeId, loopback, "native"),
        });
        assert.ok(registered, "a loopback-only document from an admitted host registers");
        assert.deepEqual(registered!.redirectUris, loopback);

        const continuation = await createOAuthContinuation({
          clientId: nativeId,
          redirectUri: "http://localhost:53712/callback",
          resource,
          scopes: ["exomem.read"],
          state: "native-loopback-state",
          codeChallenge: "native-loopback-challenge",
          offlineAccess: true,
        });
        assert.ok(continuation);
        assert.ok(
          await resolveOAuthContinuationToken(continuation!.transaction),
          "a continuation on a free port re-validates against the portless registration"
        );

        const mixed = await registerAdmittedCimdClient(mixedId, {
          fetchCimd: async () =>
            cimdMetadata(
              mixedId,
              ["http://localhost/callback", "http://evil.example/callback"],
              "mixed"
            ),
        });
        assert.equal(mixed, null, "a cleartext non-loopback redirect refuses the whole document");
        const stored = await pool!.query(
          "SELECT 1 FROM exomem_oauth_clients WHERE client_id = $1",
          [mixedId]
        );
        assert.equal(stored.rowCount, 0);
      } finally {
        if (previousKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
        else process.env.EXOMEM_CONTROL_PLANE_KEY = previousKey;
        await pool!.query(
          "DELETE FROM exomem_oauth_authorization_transactions WHERE client_id IN (SELECT id FROM exomem_oauth_clients WHERE client_id = $1)",
          [nativeId]
        );
        await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
        await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = ANY($1)", [
          [nativeId, mixedId],
        ]);
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

  it("admits two distinct connectors on the same allowlisted host", async () => {
    // The user-facing claim. Every ChatGPT connector publishes its own client.json
    // under its own connector id, so each carries a different configuration digest.
    // Pinned admission can therefore admit at most one connector on earth; this is
    // the assertion that more than one works, which is what "invite four people"
    // requires.
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

      assert.ok(await resolveApprovedCloudOAuthClient(first), "first connector must be admitted");
      assert.ok(await resolveApprovedCloudOAuthClient(second), "second connector must be admitted");

    } finally {
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = ANY($1::text[])", [
        [first, second],
      ]);
    }
  });

  it("refuses a fetched document whose redirect leaves the host that served it", async () => {
    // The one input an admitted host controls entirely is its own document. If the
    // redirect list is not held to the host, placing a document on an admitted host
    // is enough to name any delivery address for an authorization code -- which is
    // a trust the allowlist was never asked to extend.
    const host = "connector-offhost.example.test";
    await pool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      ["openai", host]
    );
    try {
      for (const redirect of [
        "https://attacker.example.test/callback",
        `https://${host}.attacker.example.test/callback`,
        `http://${host}/callback`,
        // A loopback redirect is a native client's and is admitted; see
        // "registers a native client's loopback document" (substrate#188).
      ]) {
        const clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
        const registered = await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, [redirect], "offhost"),
        });
        assert.equal(registered, null, `${redirect} must not register`);
        assert.equal(
          (await pool!.query("SELECT 1 FROM exomem_oauth_clients WHERE client_id = $1", [clientId]))
            .rowCount,
          0,
          `${redirect} must leave no row behind`
        );
      }

      // One redirect off-host is enough to refuse the whole document.
      const mixed = `https://${host}/oauth/${randomUUID()}/client.json`;
      assert.equal(
        await registerAdmittedCimdClient(mixed, {
          fetchCimd: async () =>
            cimdMetadata(
              mixed,
              [`https://${host}/callback`, "https://attacker.example.test/cb"],
              "mixed"
            ),
        }),
        null
      );

      // And the honest shape still registers, so the rule is not merely refusing everything.
      const good = `https://${host}/oauth/${randomUUID()}/client.json`;
      assert.ok(
        await registerAdmittedCimdClient(good, {
          fetchCimd: async () => cimdMetadata(good, [`https://${host}/callback`], "onhost"),
        })
      );
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [good]);
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
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
      assert.ok(await resolveApprovedCloudOAuthClient(clientId));

      // Age it out exactly the way the cache does.
      await pool!.query(
        `UPDATE exomem_oauth_clients
         SET metadata_expires_at = now() - interval '1 hour', enabled = false
         WHERE client_id = $1`,
        [clientId]
      );
      assert.equal(
        await resolveApprovedCloudOAuthClient(clientId),
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
        await resolveApprovedCloudOAuthClient(clientId),
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

  it("admits claude.ai and lets its stale operator-registered row revive itself", async () => {
    // Production, 2026-09-11: once artifact admission was removed, claude.ai had no
    // way in. 0048 never allowlisted it because the cohort digest admitted it, and
    // its one client row is operator-registered, so expiry maintenance disabled it
    // and the self-registration upsert -- the only path that refreshes lapsed
    // metadata -- is not allowed to touch it.
    const admitted = await pool!.query(
      "SELECT platform FROM exomem_oauth_admitted_cimd_hosts WHERE host = 'claude.ai'"
    );
    assert.deepEqual(admitted.rows, [{ platform: "claude" }], "a migrated schema admits claude.ai");

    const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const redirectUris = ["https://claude.ai/api/mcp/auth_callback"];
    const bootstrapHeld = `https://claude.ai/oauth/${randomUUID()}/client.json`;
    const unadmitted = `https://unadmitted.example.test/oauth/${randomUUID()}/client.json`;
    const insertStaleOperatorClient = (id: string, host: string, bootstrap: boolean) =>
      pool!.query(
        `INSERT INTO exomem_oauth_clients (
           client_id, admission_mode, enabled, auto_registered, reviewer_bootstrap_ever_authorized,
           redirect_uris, redirect_uris_digest, client_platform, oauth_client_config_sha256,
           cimd_host, metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds,
           metadata_expires_at, metadata_provenance
         ) VALUES (
           $1, 'cimd', false, false, $3, $4::jsonb,
           digest(convert_to($4::jsonb::text, 'utf8'), 'sha256'), 'claude',
           encode(digest(convert_to($1, 'utf8'), 'sha256'), 'hex'), $2,
           digest(convert_to($1, 'utf8'), 'sha256'), now() - interval '2 days', 86400,
           now() - interval '1 day', '{}'::jsonb
         )`,
        [id, host, bootstrap, JSON.stringify([`https://${host}/callback`])]
      );
    await insertStaleOperatorClient(clientId, "claude.ai", false);
    // Neighbours the hand-over must leave alone.
    await insertStaleOperatorClient(bootstrapHeld, "claude.ai", true);
    await insertStaleOperatorClient(unadmitted, "unadmitted.example.test", false);
    try {
      assert.equal(
        await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, redirectUris, "before"),
        }),
        null,
        "an operator-registered row blocks self-registration"
      );

      const migration = readFileSync(
        resolve(process.cwd(), "migrations/0055_exomem_admit_claude_ai_cimd_host.sql"),
        "utf8"
      );
      await pool!.query(migration);
      await pool!.query(migration);

      const provenance = await pool!.query<{ client_id: string; auto_registered: boolean }>(
        "SELECT client_id, auto_registered FROM exomem_oauth_clients WHERE client_id = ANY($1)",
        [[clientId, bootstrapHeld, unadmitted]]
      );
      assert.deepEqual(
        Object.fromEntries(provenance.rows.map((row) => [row.client_id, row.auto_registered])),
        { [clientId]: true, [bootstrapHeld]: false, [unadmitted]: false }
      );

      assert.ok(
        await registerAdmittedCimdClient(clientId, {
          fetchCimd: async () => cimdMetadata(clientId, redirectUris, "after"),
        }),
        "claude.ai must be able to revive its own row"
      );
      const client = await resolveApprovedCloudOAuthClient(clientId);
      assert.deepEqual(client?.redirectUris, redirectUris);
    } finally {
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = ANY($1)", [
        [clientId, bootstrapHeld, unadmitted],
      ]);
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

  const genericRegistration = {
    redirectUris: ["http://127.0.0.1:43123/callback"],
    clientName: "Local agent",
  };

  it("refuses a further generic registration at its bound while leaving operator and connector slots free", async () => {
    // Registration is an anonymous write. A flood must exhaust only its own
    // partition -- never operator control or the ChatGPT and Claude connectors --
    // and the clients those partitions hold must not shrink it either.
    const filler = `generic-bound-${randomUUID()}`;
    const overflow = `generic-overflow-${randomUUID()}`;
    await setGenericLane(true);
    try {
      const counted = await pool!.query<{ generic: string; other: string }>(
        `SELECT count(*) FILTER (WHERE admission_mode = 'generic') AS generic,
                count(*) FILTER (WHERE admission_mode <> 'generic') AS other
         FROM exomem_oauth_clients`
      );
      assert.ok(
        Number(counted.rows[0]!.other) > 0,
        "the fixture needs clients of other modes, which the generic bound must not count"
      );
      await pool!.query(
        `INSERT INTO exomem_oauth_clients (
           client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_name
         )
         SELECT format('%s-%s', $1::text, step), 'generic', true,
                '["http://127.0.0.1/callback"]'::jsonb,
                digest(convert_to('["http://127.0.0.1/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                'Filler'
         FROM generate_series(1, $2::int) AS step`,
        [filler, 128 - Number(counted.rows[0]!.generic) - 1]
      );

      const last = await registerGenericMcpClient(genericRegistration, {
        newClientId: () => `${filler}-last`,
      });
      assert.ok(last, "the last generic slot must be usable while other clients exist");
      assert.equal(
        await registerGenericMcpClient(genericRegistration, { newClientId: () => overflow }),
        null,
        "a full generic partition must refuse"
      );
      assert.equal(
        (await pool!.query("SELECT 1 FROM exomem_oauth_clients WHERE client_id = $1", [overflow]))
          .rowCount,
        0
      );

      // 128 generic rows would exceed the operator bound of 96 if they counted there.
      const probe = `https://partition-probe.example.test/${randomUUID()}/client.json`;
      const free = await pool!.query<{ operator: boolean; connector: boolean }>(
        `SELECT exomem_oauth_client_partition_available($1, false) AS operator,
                exomem_oauth_client_partition_available($1, true) AS connector`,
        [probe]
      );
      assert.deepEqual(free.rows[0], { operator: true, connector: true });
    } finally {
      await setGenericLane(false);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id LIKE $1", [
        `${filler}%`,
      ]);
    }
  });

  it("never lets a generic registration rewrite or enable another client", async () => {
    // Identifiers are server-assigned, so no registration names an existing
    // client. Should one ever collide, the existing client -- here a disabled
    // operator-managed one -- must be left exactly as it was.
    const operatorClientId = `operator-${randomUUID()}`;
    await setGenericLane(true);
    try {
      await pool!.query(
        `INSERT INTO exomem_oauth_clients (
           client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
           client_platform, oauth_client_config_sha256
         ) VALUES ($1, 'pinned', false, '["https://operator.example.test/callback"]'::jsonb,
                   digest(convert_to('["https://operator.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                   'claude', $2)`,
        [operatorClientId, "e".repeat(64)]
      );
      const before = await pool!.query("SELECT * FROM exomem_oauth_clients WHERE client_id = $1", [
        operatorClientId,
      ]);
      assert.equal(
        await registerGenericMcpClient(genericRegistration, { newClientId: () => operatorClientId }),
        null
      );
      const after = await pool!.query("SELECT * FROM exomem_oauth_clients WHERE client_id = $1", [
        operatorClientId,
      ]);
      assert.deepEqual(after.rows, before.rows);
    } finally {
      await setGenericLane(false);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [operatorClientId]);
    }
  });

  async function setGenericLane(enabled: boolean): Promise<void> {
    await pool!.query("UPDATE exomem_oauth_generic_client_lane SET enabled = $1, updated_at = now()", [
      enabled,
    ]);
  }

  /** A browser authorization for `clientId`, as /authorize persists it. */
  async function beginAuthorization(clientId: string, redirectUri: string) {
    const transactionDigest = randomBytes(32);
    const created = await createAuthorizationTransaction({
      transactionDigest,
      stateDigest: randomBytes(32),
      stateEnvelope: {} as SecretEnvelope,
      formNonceDigest: randomBytes(32),
      continuationBinding: randomBytes(32),
      clientId,
      redirectUri,
      resource,
      scopes: ["exomem.read", "exomem.write", "offline_access"],
      pkceChallenge: "challenge",
      expiresAt: new Date(Date.now() + 600_000),
    });
    return created ? transactionDigest : null;
  }

  /** An entitled owner with a browser session and a running cell. */
  async function seedSignedInOwner(): Promise<{ sessionId: string; tenantId: string }> {
    const user = await pool!.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`crossstage-${randomUUID()}@example.test`]
    );
    const tenant = await pool!.query<{ id: string }>(
      "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
      [user.rows[0]!.id]
    );
    await pool!.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'active', 'active')`,
      [tenant.rows[0]!.id]
    );
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [randomCloudCellId(), tenant.rows[0]!.id]
    );
    const session = await pool!.query<{ id: string }>(
      `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
      [user.rows[0]!.id, tenant.rows[0]!.id, randomBytes(32), randomBytes(32)]
    );
    return { sessionId: session.rows[0]!.id, tenantId: tenant.rows[0]!.id };
  }

  async function seedComplimentaryInvite(): Promise<Buffer> {
    const inviteDigest = randomBytes(32);
    await pool!.query(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities,
         entitlement_limits, created_by_principal_digest, expires_at
       ) VALUES ($1, $2, 'complimentary', '["capture","recall"]'::jsonb, '{}'::jsonb, $3,
                 now() + interval '1 day')`,
      [inviteDigest, `crossstage-invitee-${randomUUID()}@example.test`, randomBytes(32)]
    );
    return inviteDigest;
  }

  // The admission clause lives in eight statements: client resolution, the
  // authorization transaction, consent, owner attachment, invite admission,
  // token exchange, refresh and the gateway's token lookup. A missed one does not
  // fail at authorize -- it fails later, as a client that signs in and then
  // cannot keep its session, which reads as an intermittent client bug. Drive one
  // client of each self-registering lane through every stage, then withdraw its
  // lane and require every stage to stop. The negative half is the drift guard:
  // a predicate that ignored the lane would keep admitting after withdrawal.
  //
  // The host-allowlisted client runs with the generic lane enabled, so a generic
  // arm that did not check the admission mode would keep admitting it once its
  // host is withdrawn.
  for (const lane of ["host-allowlisted", "generic"] as const) {
    it(`admits a ${lane} client at every stage, and withdraws it at every stage`, async () => {
      const host = `crossstage-${lane}-${randomUUID()}.example.test`;
      const redirectUri = `https://${host}/callback`;
      const capacityNode = `crossstage-${randomUUID()}`;
      let clientId = "";
      await setGenericLane(true);
      await pool!.query(
        "INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at) VALUES ($1, 1000, now())",
        [capacityNode]
      );
      try {
        if (lane === "generic") {
          const registered = await registerGenericMcpClient({
            redirectUris: [redirectUri],
            clientName: "Cross-stage agent",
          });
          assert.ok(registered, "registration must succeed while the lane is enabled");
          clientId = registered!.clientId;
        } else {
          clientId = `https://${host}/oauth/${randomUUID()}/client.json`;
          await pool!.query(
            "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('openai', $1)",
            [host]
          );
          assert.ok(
            await registerAdmittedCimdClient(clientId, {
              fetchCimd: async () => cimdMetadata(clientId, [redirectUri], "cross-stage"),
            })
          );
        }
        const owner = await seedSignedInOwner();
        const exchange = (codeDigest: Buffer, refreshDigest: Buffer, accessDigest: Buffer) =>
          issueOAuthTokensFromCodeAtomic({
            codeDigest,
            clientId,
            redirectUri,
            resource,
            pkceChallenge: "challenge",
            refreshDigest,
            refreshExpiresAt: new Date(Date.now() + 3_600_000),
            accessDigest,
            accessExpiresAt: new Date(Date.now() + 60_000),
          });
        const refresh = (refreshDigest: Buffer, replacement: Buffer, accessDigest: Buffer) =>
          rotateOAuthRefreshTokenAtomic({
            refreshDigest,
            replacementRefreshDigest: replacement,
            accessDigest,
            accessExpiresAt: new Date(Date.now() + 60_000),
            clientId,
            resource,
          });
        const admitInvitee = (inviteDigest: Buffer, transactionDigest: Buffer) =>
          admitFirstCloudOAuthInviteAtomic({
            inviteDigest,
            transactionDigest,
            sessionDigest: randomBytes(32),
            csrfDigest: randomBytes(32),
            sessionExpiresAt: new Date(Date.now() + 3_600_000),
            codeDigest: randomBytes(32),
            codeExpiresAt: new Date(Date.now() + 60_000),
          });

        // Every stage admits.
        assert.ok(await resolveApprovedCloudOAuthClient(clientId), "authorize must admit");
        const consentNow = await beginAuthorization(clientId, redirectUri);
        assert.ok(consentNow, "the authorization transaction must admit");
        const consentLater = (await beginAuthorization(clientId, redirectUri))!;
        const codeLaterTransaction = (await beginAuthorization(clientId, redirectUri))!;
        const inviteNow = (await beginAuthorization(clientId, redirectUri))!;
        const inviteLater = (await beginAuthorization(clientId, redirectUri))!;
        assert.ok(await findPendingOAuthAuthorization(consentNow!), "consent must admit");
        const codeNow = randomBytes(32);
        assert.ok(
          await attachExistingOwnerAuthorizationAtomic({
            sessionId: owner.sessionId,
            transactionDigest: consentNow!,
            codeDigest: codeNow,
            codeExpiresAt: new Date(Date.now() + 60_000),
          }),
          "owner attachment must admit"
        );
        const codeLater = randomBytes(32);
        assert.ok(
          await attachExistingOwnerAuthorizationAtomic({
            sessionId: owner.sessionId,
            transactionDigest: codeLaterTransaction,
            codeDigest: codeLater,
            codeExpiresAt: new Date(Date.now() + 60_000),
          })
        );
        assert.ok(
          await admitInvitee(await seedComplimentaryInvite(), inviteNow),
          "invite admission must admit"
        );
        const firstRefresh = randomBytes(32);
        const firstAccess = randomBytes(32);
        assert.ok(await exchange(codeNow, firstRefresh, firstAccess), "token exchange must admit");
        assert.ok(
          await findCloudOAuthAccessToken(firstAccess, resource),
          "the gateway's token lookup must admit"
        );
        const secondRefresh = randomBytes(32);
        const secondAccess = randomBytes(32);
        assert.ok(await refresh(firstRefresh, secondRefresh, secondAccess), "refresh must admit");

        // Vary only the lane under test.
        if (lane === "generic") await setGenericLane(false);
        else
          await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);

        // Every stage refuses.
        assert.equal(await resolveApprovedCloudOAuthClient(clientId), null, "authorize must stop");
        assert.equal(
          await beginAuthorization(clientId, redirectUri),
          null,
          "the authorization transaction must stop"
        );
        assert.equal(await findPendingOAuthAuthorization(consentLater), null, "consent must stop");
        assert.equal(
          await attachExistingOwnerAuthorizationAtomic({
            sessionId: owner.sessionId,
            transactionDigest: consentLater,
            codeDigest: randomBytes(32),
            codeExpiresAt: new Date(Date.now() + 60_000),
          }),
          null,
          "owner attachment must stop"
        );
        assert.equal(
          await admitInvitee(await seedComplimentaryInvite(), inviteLater),
          null,
          "invite admission must stop"
        );
        assert.equal(
          await exchange(codeLater, randomBytes(32), randomBytes(32)),
          null,
          "token exchange must stop"
        );
        assert.equal(
          await findCloudOAuthAccessToken(secondAccess, resource),
          null,
          "the gateway's token lookup must stop"
        );
        assert.equal(
          await refresh(secondRefresh, randomBytes(32), randomBytes(32)),
          null,
          "refresh must stop"
        );
      } finally {
        await setGenericLane(false);
        await pool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
        await pool!.query("DELETE FROM exomem_cloud_capacity WHERE node = $1", [capacityNode]);
        // The client owns a grant graph, and the foreign keys say so. Unwind it in
        // dependency order rather than leaving the row behind, so the
        // population-bound tests still count clean partitions.
        await pool!.query(
          `DELETE FROM exomem_oauth_grants WHERE client_id IN (
             SELECT id FROM exomem_oauth_clients WHERE client_id = $1)`,
          [clientId]
        );
        await pool!.query(
          `DELETE FROM exomem_oauth_authorization_transactions WHERE client_id IN (
             SELECT id FROM exomem_oauth_clients WHERE client_id = $1)`,
          [clientId]
        );
        await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [clientId]);
      }
    });
  }

  it("keeps the registration endpoint undiscoverable while disabled, and refuses every request alike", async () => {
    // A refusal that differed by cause would tell an anonymous caller whether the
    // lane is on, how full it is, or which rule a probe tripped.
    const previousKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
    const previousBaseUrl = process.env.EXOMEM_PUBLIC_BASE_URL;
    process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 9).toString("base64url");
    process.env.EXOMEM_PUBLIC_BASE_URL = "https://hosted.example.test";
    const { GET: metadata } =
      await import("../../../app/.well-known/oauth-authorization-server/api/exomem/oauth/route");
    const { POST: register } = await import("../../../app/api/exomem/oauth/register/route");
    const run = randomUUID();
    const post = (body: unknown, address: string) =>
      register(
        new Request("https://hosted.example.test/api/exomem/oauth/register", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `${address}-${run}` },
          body: typeof body === "string" ? body : JSON.stringify(body),
        })
      );
    const refusal = async (response: Response) => ({
      status: response.status,
      body: await response.text(),
      headers: [...response.headers].sort(),
    });
    const valid = {
      client_name: "Probe agent",
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      token_endpoint_auth_method: "none",
    };
    const clients = () => scalar("SELECT count(*) FROM exomem_oauth_clients");
    const registrationEndpoint = async () =>
      ((await (await metadata()).json()) as { registration_endpoint?: string })
        .registration_endpoint;
    let registeredClientId = "";
    try {
      const clientsBefore = await clients();
      assert.equal(await registrationEndpoint(), undefined, "a disabled lane is not advertised");
      const disabled = await refusal(await post(valid, "disabled"));
      assert.equal(disabled.status, 404);

      await setGenericLane(true);
      assert.equal(
        await registrationEndpoint(),
        "https://hosted.example.test/api/exomem/oauth/register"
      );
      const unsafe = { ...valid, redirect_uris: ["http://agent.example.test/callback"] };
      assert.deepEqual(await refusal(await post(unsafe, "unsafe")), disabled);
      assert.deepEqual(await refusal(await post("{not json", "malformed")), disabled);
      for (let attempt = 0; attempt < EXOMEM_RATE_LIMITS.oauthClientRegisterIp.limit; attempt += 1) {
        await post(unsafe, "flood");
      }
      assert.deepEqual(await refusal(await post(valid, "flood")), disabled, "rate limited");
      assert.equal(await clients(), clientsBefore, "no refusal writes a client");

      // The MCP SDK's example client asks for a secret it can post. RFC 7591 lets
      // the server answer with what it actually registered: a public client.
      const created = await post(
        {
          ...valid,
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code", "refresh_token"],
        },
        "accepted"
      );
      assert.equal(created.status, 201);
      const body = (await created.json()) as Record<string, unknown>;
      registeredClientId = String(body.client_id);
      assert.equal(body.token_endpoint_auth_method, "none");
      assert.equal("client_secret" in body, false);
      // Grant types are neither stored nor enforced per client, so none are reported.
      assert.equal("grant_types" in body, false);
      assert.deepEqual(body.redirect_uris, valid.redirect_uris);
      const stored = await pool!.query(
        "SELECT admission_mode, client_platform, client_name FROM exomem_oauth_clients WHERE client_id = $1",
        [registeredClientId]
      );
      assert.deepEqual(stored.rows[0], {
        admission_mode: "generic",
        client_platform: null,
        client_name: "Probe agent",
      });
    } finally {
      await setGenericLane(false);
      await pool!.query("DELETE FROM exomem_oauth_clients WHERE client_id = $1", [
        registeredClientId,
      ]);
      if (previousKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
      else process.env.EXOMEM_CONTROL_PLANE_KEY = previousKey;
      if (previousBaseUrl === undefined) delete process.env.EXOMEM_PUBLIC_BASE_URL;
      else process.env.EXOMEM_PUBLIC_BASE_URL = previousBaseUrl;
    }
  });

  // The consent form's `Connect` button is the last gate in the OAuth flow, and
  // until now nothing exercised it against data this code actually minted:
  // every test of the complete route mocks `validateOAuthContinuationNonce`
  // wholesale, and `createOAuthContinuation` was never called by any test at
  // all. That left the mint -> resolve -> validate chain -- the one the button
  // depends on -- proven only by inspection, which is how a bare 400 reached a
  // live promotion window.
  it("validates the form nonce it minted, through a real transaction round-trip", async () => {
    // Sealing the continuation envelope needs a control-plane key, and this is
    // the only test in this file that encrypts anything, so the suite has never
    // required one. Supply it here rather than from the environment: a test that
    // depends on ambient configuration passes on the machine that happens to
    // export it and fails in CI, which is exactly what it did.
    const previousKey = process.env.EXOMEM_CONTROL_PLANE_KEY;
    process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 7).toString("base64url");
    try {
      await runContinuationRoundTrip();
    } finally {
      if (previousKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
      else process.env.EXOMEM_CONTROL_PLANE_KEY = previousKey;
    }
  });

  async function runContinuationRoundTrip(): Promise<void> {
    await seedClient();
    const redirectUri = "https://client.example.test/callback";
    const created = await createOAuthContinuation({
      clientId,
      redirectUri,
      resource,
      scopes: ["exomem.read"],
      state: "continuity-integration-state",
      codeChallenge: "continuity-integration-challenge",
      offlineAccess: true,
    });
    assert.ok(created, "the continuation must mint");

    // Resolving is what the consent page does to decide it can render Connect.
    const continuation = await resolveOAuthContinuationToken(created!.transaction);
    assert.ok(continuation, "a freshly minted continuation must resolve from its own token");

    // `scopes` is the only input to the continuation binding that the resolver
    // does not cross-check against the encrypted envelope, so it is the only one
    // that can silently diverge across the database round-trip. Assert it
    // directly: a mismatch here fails the binding below for a reason the bare
    // `invalid_request` would never name.
    assert.deepEqual(
      [...continuation!.scopes].sort(),
      ["exomem.read", "offline_access"],
      "requested_scopes must round-trip as the extended scope set used for the binding"
    );

    assert.equal(
      validateOAuthContinuationNonce({
        continuation: continuation!,
        transaction: created!.transaction,
        formNonce: created!.formNonce,
      }),
      true,
      "the form nonce minted with a continuation must validate against it"
    );

    // The nonce is this form's CSRF defence; a foreign nonce must still fail.
    const other = await createOAuthContinuation({
      clientId,
      redirectUri,
      resource,
      scopes: ["exomem.read"],
      state: "continuity-integration-state-other",
      codeChallenge: "continuity-integration-challenge",
      offlineAccess: true,
    });
    assert.ok(other, "the second continuation must mint");
    assert.equal(
      validateOAuthContinuationNonce({
        continuation: continuation!,
        transaction: created!.transaction,
        formNonce: other!.formNonce,
      }),
      false,
      "a nonce from a different transaction must not validate"
    );
  }
});
