import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { EXOMEM_ALPHA_CAPACITY } from "../oauth-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  admitFirstOAuthInviteAtomic,
  attachExistingOwnerAuthorizationAtomic,
  issueOAuthTokensFromCodeAtomic,
  pruneExpiredOAuthState,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "https://client.example.test/metadata.json";
const resource = "https://substratesystems.io/api/exomem/mcp/v1";
let pool: Pool | undefined;
let schema: string | undefined;

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

async function seedClient(): Promise<string> {
  const result = await pool!.query(
    `INSERT INTO exomem_oauth_clients (client_id, admission_mode, enabled, redirect_uris)
     VALUES ($1, 'pinned', true, '["https://client.example.test/callback"]'::jsonb)
     ON CONFLICT (client_id) DO UPDATE SET enabled = true
     RETURNING id`,
    [clientId]
  );
  return result.rows[0].id;
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
  return { codeDigest, grantId: grant.rows[0].id };
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
    assert.equal(await admitFirstOAuthInviteAtomic(admissionInput(220)), null);
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
