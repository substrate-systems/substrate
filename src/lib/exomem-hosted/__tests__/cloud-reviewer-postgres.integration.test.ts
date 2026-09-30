import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { randomCloudCellId } from "../cloud-admission";
import {
  createOrRotateCloudReviewerCredentialAtomic as issueReviewer,
  createCloudReviewerOAuthSessionAtomic,
  revokeCloudReviewerCredentialAtomic,
  findCloudReviewerCredentialForAuthentication,
  getCloudReviewerCredentialStatus,
} from "../cloud-reviewer-access-store";
import {
  attachExistingOwnerAuthorizationAtomic,
  issueOAuthTokensFromCodeAtomic,
  rotateOAuthRefreshTokenAtomic,
} from "../oauth-store";
import { findCloudOAuthAccessToken } from "../cloud-oauth";
import { findExomemSessionByDigest, rotateExomemSessionAtomic } from "../db";
import {
  authenticateMarketplaceReviewerCredential,
  generateMarketplaceReviewerCredential,
  hashMarketplaceReviewerPassword,
} from "../reviewer-access";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";
let pool: Pool;
let schema: string;
let statementBarrier: ((text: string) => Promise<void>) | null = null;
const environmentKeys = [
  "EXOMEM_CLOUD_ENABLED",
  "EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED",
  "EXOMEM_CLOUD_MCP_URL",
  "EXOMEM_CLOUD_MCP_PATH",
] as const;
const priorEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    if (statementBarrier) await statementBarrier(text);
    const result = await client.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

async function transaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

async function sample(purpose = true) {
  const user = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `review-${randomUUID()}@example.test`,
  ]);
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose) VALUES ($1, 'active', 'running', $2) RETURNING id",
    [user.rows[0].id, purpose]
  );
  const tenantId = tenant.rows[0].id as string;
  const ownerUserId = user.rows[0].id as string;
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, observed_state, ready) VALUES ($1, $2, 'running', 'running', true)",
    [randomCloudCellId(), tenantId]
  );
  await pool.query(
    "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'complimentary_active', 'active')",
    [tenantId]
  );
  return { tenantId, ownerUserId };
}

async function insertCredential(
  target: { tenantId: string; ownerUserId: string },
  kind = "cloud_provider_review",
  provider = "openai"
) {
  return pool.query(
    "INSERT INTO exomem_marketplace_reviewer_credentials (provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at, credential_kind) VALUES ($1, $2, '$argon2id$test', $3, $4, 'sample-v1', $5, $6, now() + interval '1 day', $7) RETURNING id",
    [
      provider,
      randomBytes(32),
      target.ownerUserId,
      target.tenantId,
      "a".repeat(64),
      randomBytes(32),
      kind,
    ]
  );
}

async function reviewerFixture(provider: "openai" | "anthropic" = "openai") {
  const target = await sample();
  const usernameDigest = randomBytes(32);
  const expiresAt = new Date(Date.now() + 3_600_000);
  const issued = await issueReviewer({
    ...target,
    provider,
    usernameDigest,
    passwordHash: "$argon2id$test",
    fixtureVersion: "sample-v1",
    fixturePayloadDigest: "a".repeat(64),
    expiresAt,
    operatorPrincipalDigest: randomBytes(32),
  });
  assert.ok(issued);
  const clientId = `review-${randomUUID()}`;
  const redirectUri = "https://review.example.test/callback";
  const client = await pool.query(
    "INSERT INTO exomem_oauth_clients (client_id, client_platform, admission_mode, enabled, redirect_uris, redirect_uris_digest, oauth_client_config_sha256) VALUES ($1, $2, 'pinned', true, $3::jsonb, digest(convert_to($3::jsonb::text, 'utf8'), 'sha256'), $4) RETURNING id",
    [
      clientId,
      provider === "openai" ? "openai" : "claude",
      JSON.stringify([redirectUri]),
      randomBytes(32).toString("hex"),
    ]
  );
  const transactionDigest = randomBytes(32);
  await pool.query(
    "INSERT INTO exomem_oauth_authorization_transactions (transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at) VALUES ($1, $2, $3, $4, ARRAY['exomem.read','exomem.write','offline_access'], $5, '{}'::jsonb, $6, $7, 'challenge', now() + interval '1 day')",
    [
      transactionDigest,
      client.rows[0].id,
      redirectUri,
      CLOUD_RESOURCE,
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
    ]
  );
  const sessionDigest = randomBytes(32);
  const csrfDigest = randomBytes(32);
  const sessionInput = {
    credentialId: issued.credentialId,
    transactionDigest,
    sessionDigest,
    csrfDigest,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
  const session = await createCloudReviewerOAuthSessionAtomic(sessionInput);
  assert.ok(session);
  return {
    ...target,
    credentialId: issued.credentialId,
    provider,
    usernameDigest,
    expiresAt,
    clientId,
    clientDbId: client.rows[0].id as string,
    redirectUri,
    transactionDigest,
    sessionInput,
    sessionId: session.sessionId,
    sessionDigest,
  };
}

async function grantCode(fixture: Awaited<ReturnType<typeof reviewerFixture>>) {
  const codeDigest = randomBytes(32);
  const granted = await attachExistingOwnerAuthorizationAtomic({
    sessionId: fixture.sessionId,
    transactionDigest: fixture.transactionDigest,
    codeDigest,
    codeExpiresAt: new Date(Date.now() + 86_400_000),
  });
  assert.ok(granted);
  return {
    codeDigest,
    clientId: fixture.clientId,
    redirectUri: fixture.redirectUri,
    resource: CLOUD_RESOURCE,
    pkceChallenge: "challenge",
    refreshDigest: randomBytes(32),
    refreshExpiresAt: new Date(Date.now() + 86_400_000),
    accessDigest: randomBytes(32),
    accessExpiresAt: new Date(Date.now() + 86_400_000),
  };
}

async function authorize(fixture: Awaited<ReturnType<typeof reviewerFixture>>) {
  const input = await grantCode(fixture);
  const minted = await issueOAuthTokensFromCodeAtomic(input);
  assert.ok(minted);
  return { ...input, ...minted };
}

function refreshInput(fixture: Awaited<ReturnType<typeof reviewerFixture>>, refreshDigest: Buffer) {
  return {
    refreshDigest,
    clientId: fixture.clientId,
    resource: CLOUD_RESOURCE,
    replacementRefreshDigest: randomBytes(32),
    accessDigest: randomBytes(32),
    accessExpiresAt: new Date(Date.now() + 86_400_000),
  };
}

describe("Cloud reviewer PostgreSQL authority", { skip: !databaseUrl }, () => {
  before(async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
    process.env.EXOMEM_CLOUD_MCP_URL = CLOUD_RESOURCE;
    process.env.EXOMEM_CLOUD_MCP_PATH = "/api/exomem/cloud/mcp/v1";
    schema = `cloud_review_it_${randomUUID().replaceAll("-", "")}`;
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
  after(async () => {
    statementBarrier = null;
    for (const key of environmentKeys) {
      if (priorEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = priorEnvironment[key];
    }
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("accepts Cloud kind with no candidate authority while retaining Hosted provider kind", async () => {
    const target = await sample();
    const hosted = await insertCredential(target, "provider_review");
    const cloud = await insertCredential(target);
    assert.ok(cloud.rows[0].id);
    await assert.rejects(
      pool.query(
        "UPDATE exomem_marketplace_reviewer_credentials SET credential_kind = 'provider_review' WHERE id = $1",
        [cloud.rows[0].id]
      ),
      /immutable/
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO exomem_marketplace_reviewer_credentials SELECT * FROM exomem_marketplace_reviewer_credentials WHERE id = $1",
        [cloud.rows[0].id]
      )
    );
    await pool.query(
      "UPDATE exomem_marketplace_reviewer_credentials SET revoked_at = now() WHERE id = ANY($1::uuid[])",
      [[hosted.rows[0].id, cloud.rows[0].id]]
    );
  });

  it("issues a bounded credential for an existing complimentary sample Cloud tenant without Hosted artifacts", async () => {
    const target = await sample();
    const issued = await issueReviewer({
      ...target,
      provider: "openai",
      usernameDigest: randomBytes(32),
      passwordHash: "$argon2id$test",
      fixtureVersion: "sample-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
      operatorPrincipalDigest: randomBytes(32),
    });
    assert.ok(issued);
    const credential = await pool.query(
      "SELECT credential_kind, candidate_id FROM exomem_marketplace_reviewer_credentials WHERE id = $1",
      [issued.credentialId]
    );
    assert.equal(credential.rows[0].credential_kind, "cloud_provider_review");
    assert.equal(credential.rows[0].candidate_id, null);
  });

  it("preserves reviewer identity and expiry when a browser session is rotated", async () => {
    const fixture = await reviewerFixture();
    const digest = randomBytes(32);
    assert.ok(
      await rotateExomemSessionAtomic({
        sessionId: fixture.sessionId,
        sessionDigest: digest,
        csrfDigest: randomBytes(32),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    );
    const session = await pool.query(
      "SELECT reviewer_credential_id, expires_at FROM exomem_sessions WHERE session_digest = $1",
      [digest]
    );
    assert.equal(session.rows[0].reviewer_credential_id, fixture.credentialId);
    assert.ok(session.rows[0].expires_at.getTime() <= fixture.expiresAt.getTime());
  });

  it("refuses a refresh whose reviewer identity differs despite NULL candidate lineage", async () => {
    const fixture = await reviewerFixture();
    const tokens = await authorize(fixture);
    const other = await reviewerFixture("anthropic");
    await pool.query(
      "UPDATE exomem_oauth_refresh_tokens SET reviewer_credential_id = $1 WHERE refresh_digest = $2",
      [other.credentialId, tokens.refreshDigest]
    );
    assert.equal(
      await rotateOAuthRefreshTokenAtomic(refreshInput(fixture, tokens.refreshDigest)),
      null
    );
  });

  it("refuses payment-bearing reviewer authority at session, consent, mint, refresh and Cloud access", async () => {
    const fixture = await reviewerFixture();
    const tokens = await authorize(fixture);
    assert.ok(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE));
    await pool.query(
      "UPDATE exomem_entitlements SET source = 'paddle', provider_customer_ref = $2, provider_environment = 'sandbox' WHERE tenant_id = $1",
      [fixture.tenantId, `ctm_${randomUUID()}`]
    );
    assert.equal(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE), null);
    assert.equal(await findExomemSessionByDigest(fixture.sessionDigest), null);
    assert.equal(
      await rotateOAuthRefreshTokenAtomic(refreshInput(fixture, tokens.refreshDigest)),
      null
    );
  });

  it("refuses Hosted-kind reviewer lineage on the Cloud resource at consent", async () => {
    const fixture = await reviewerFixture();
    const hosted = await insertCredential(fixture, "provider_review", "anthropic");
    await pool.query("UPDATE exomem_sessions SET reviewer_credential_id = $1 WHERE id = $2", [
      hosted.rows[0].id,
      fixture.sessionId,
    ]);
    await pool.query(
      "UPDATE exomem_oauth_authorization_transactions SET reviewer_credential_id = $1 WHERE transaction_digest = $2",
      [hosted.rows[0].id, fixture.transactionDigest]
    );
    await pool.query("UPDATE exomem_oauth_clients SET client_platform = 'claude' WHERE id = $1", [
      fixture.clientDbId,
    ]);
    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: fixture.sessionId,
        transactionDigest: fixture.transactionDigest,
        codeDigest: randomBytes(32),
        codeExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
  });

  it("rejects Cloud candidate authority at the schema boundary", async () => {
    const fixture = await reviewerFixture();
    await assert.rejects(
      pool.query(
        "UPDATE exomem_marketplace_reviewer_credentials SET assignment_generation = 1 WHERE id = $1",
        [fixture.credentialId]
      ),
      /immutable/
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO exomem_marketplace_reviewer_credentials (provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version, fixture_payload_digest, created_by_principal_digest, expires_at, credential_kind, assignment_generation) VALUES ('openai', $1, '$argon2id$test', $2, $3, 'sample-v1', $4, $5, now() + interval '1 day', 'cloud_provider_review', 1)",
        [randomBytes(32), fixture.ownerUserId, fixture.tenantId, "a".repeat(64), randomBytes(32)]
      ),
      (error: unknown) =>
        (error as { constraint?: string }).constraint ===
        "exomem_reviewer_credentials_candidate_lineage_complete"
    );
  });

  it("refuses ineligible issuance without rotating existing authority or converting an ordinary tenant", async () => {
    const valid = await reviewerFixture();
    const ordinary = await sample(false);
    const issue = (
      target: { tenantId: string; ownerUserId: string },
      expiresAt = new Date(Date.now() + 86_400_000)
    ) =>
      issueReviewer({
        ...target,
        provider: "openai",
        usernameDigest: randomBytes(32),
        passwordHash: "$argon2id$test",
        fixtureVersion: "sample-v1",
        fixturePayloadDigest: "a".repeat(64),
        expiresAt,
        operatorPrincipalDigest: randomBytes(32),
      });
    assert.equal(await issue(ordinary), null);
    await assert.rejects(issue(valid, new Date(Date.now() + 91 * 86_400_000)), /expiry/);
    await assert.rejects(issue(valid, new Date(Date.now() - 1000)), /expiry/);
    for (const change of [
      "UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE tenant_id = $1",
      "UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE tenant_id = $1",
      "UPDATE exomem_cloud_cells SET observed_state = 'failed', ready = false WHERE tenant_id = $1",
      "UPDATE exomem_entitlements SET effective_state = 'cancelled' WHERE tenant_id = $1",
      "UPDATE exomem_entitlements SET source = 'paddle', provider_customer_ref = 'ctm_issue', provider_environment = 'sandbox' WHERE tenant_id = $1",
      "UPDATE exomem_entitlements SET source = 'paddle', provider_subscription_ref = 'sub_issue', provider_environment = 'sandbox' WHERE tenant_id = $1",
      "UPDATE exomem_entitlements SET source = 'paddle', provider_transaction_ref = 'txn_issue', provider_environment = 'sandbox' WHERE tenant_id = $1",
    ]) {
      const target = await sample();
      await pool.query(change, [target.tenantId]);
      assert.equal(await issue(target), null);
    }
    const blocked = await sample();
    await pool.query(
      "INSERT INTO exomem_oauth_account_blocks (owner_user_id, tenant_id, blocked_reason) VALUES ($1, $2, 'operator_revoked')",
      [blocked.ownerUserId, blocked.tenantId]
    );
    assert.equal(await issue(blocked), null);
    const deleted = await sample();
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [deleted.ownerUserId]);
    assert.equal(await issue(deleted), null);
    assert.ok(await findCloudReviewerCredentialForAuthentication(valid.usernameDigest));
    const purpose = await pool.query(
      "SELECT marketplace_reviewer_purpose FROM exomem_tenants WHERE id = $1",
      [ordinary.tenantId]
    );
    assert.equal(purpose.rows[0].marketplace_reviewer_purpose, false);
  });

  it("authenticates a hashed credential through existing throttled Argon2 verification and returns value-free status", async () => {
    const target = await sample();
    const credential = generateMarketplaceReviewerCredential();
    const created = await issueReviewer({
      ...target,
      provider: "openai",
      usernameDigest: credential.usernameDigest,
      passwordHash: await hashMarketplaceReviewerPassword(credential.password),
      fixtureVersion: "sample-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
      operatorPrincipalDigest: randomBytes(32),
    });
    assert.ok(created);
    const dependencies = {
      enabled: true,
      lookup: findCloudReviewerCredentialForAuthentication,
      takeRateLimit: async () => true,
    };
    assert.ok(
      await authenticateMarketplaceReviewerCredential(
        { ...credential, clientAddress: "test" },
        dependencies
      )
    );
    assert.equal(
      await authenticateMarketplaceReviewerCredential(
        { username: credential.username, password: "wrong", clientAddress: "test" },
        dependencies
      ),
      null
    );
    assert.equal(
      await authenticateMarketplaceReviewerCredential(
        { username: "unknown", password: "wrong", clientAddress: "test" },
        dependencies
      ),
      null
    );
    assert.equal(
      await authenticateMarketplaceReviewerCredential(
        { ...credential, clientAddress: "test" },
        { ...dependencies, takeRateLimit: async () => false }
      ),
      null
    );
    const status = await getCloudReviewerCredentialStatus("openai");
    assert.deepEqual(Object.keys(status!).sort(), [
      "expiresAt",
      "fixturePayloadDigest",
      "fixtureVersion",
      "provider",
      "revokedAt",
    ]);
    assert.equal(JSON.stringify(status).includes(credential.password), false);
    assert.equal(JSON.stringify(status).includes(credential.username), false);
  });

  it("binds only the exact credential/resource/provider transaction and safely retries the same identity", async () => {
    const fixture = await reviewerFixture();
    assert.deepEqual(await createCloudReviewerOAuthSessionAtomic(fixture.sessionInput), {
      sessionId: fixture.sessionId,
    });
    const other = await reviewerFixture("anthropic");
    await pool.query("UPDATE exomem_oauth_clients SET client_platform = 'claude' WHERE id = $1", [
      fixture.clientDbId,
    ]);
    assert.equal(
      await createCloudReviewerOAuthSessionAtomic({
        ...fixture.sessionInput,
        credentialId: other.credentialId,
        sessionDigest: randomBytes(32),
      }),
      null
    );
    for (const query of [
      "UPDATE exomem_oauth_authorization_transactions SET resource = 'https://hosted.example.test/mcp' WHERE transaction_digest = $1",
      "UPDATE exomem_oauth_authorization_transactions SET expires_at = now() - interval '1 minute', created_at = now() - interval '1 day' WHERE transaction_digest = $1",
      "UPDATE exomem_oauth_authorization_transactions SET consumed_at = now() WHERE transaction_digest = $1",
    ]) {
      const candidate = await reviewerFixture();
      await pool.query(query, [candidate.transactionDigest]);
      assert.equal(
        await createCloudReviewerOAuthSessionAtomic({
          ...candidate.sessionInput,
          sessionDigest: randomBytes(32),
        }),
        null
      );
    }
    const candidate = await reviewerFixture();
    await pool.query("UPDATE exomem_oauth_clients SET client_platform = 'claude' WHERE id = $1", [
      candidate.clientDbId,
    ]);
    assert.equal(
      await createCloudReviewerOAuthSessionAtomic({
        ...candidate.sessionInput,
        sessionDigest: randomBytes(32),
      }),
      null
    );
  });

  it("caps every OAuth expiry and preserves credential identity through consent, exchange and refresh", async () => {
    const fixture = await reviewerFixture();
    const tokens = await authorize(fixture);
    const next = refreshInput(fixture, tokens.refreshDigest);
    assert.ok(await rotateOAuthRefreshTokenAtomic(next));
    assert.ok(await findCloudOAuthAccessToken(next.accessDigest, CLOUD_RESOURCE));
    const session = await findExomemSessionByDigest(fixture.sessionDigest);
    assert.equal(session?.reviewerCredentialId, fixture.credentialId);
    assert.equal(session?.reviewerCredentialKind, "cloud_provider_review");
    for (const table of [
      "exomem_sessions",
      "exomem_oauth_authorization_codes",
      "exomem_oauth_token_families",
      "exomem_oauth_refresh_tokens",
      "exomem_oauth_access_tokens",
    ]) {
      const records = await pool.query(
        `SELECT reviewer_credential_id, expires_at FROM ${table} WHERE reviewer_credential_id = $1`,
        [fixture.credentialId]
      );
      assert.ok(records.rows.length > 0);
      for (const record of records.rows)
        assert.ok(record.expires_at.getTime() <= fixture.expiresAt.getTime(), table);
    }
    await pool.query(
      "UPDATE exomem_marketplace_reviewer_credentials SET expires_at = now() - interval '1 second', created_at = now() - interval '1 day' WHERE id = $1",
      [fixture.credentialId]
    );
    assert.equal(await findExomemSessionByDigest(fixture.sessionDigest), null);
    assert.equal(await findCloudOAuthAccessToken(next.accessDigest, CLOUD_RESOURCE), null);
    assert.equal(
      await rotateOAuthRefreshTokenAtomic({
        ...next,
        refreshDigest: next.replacementRefreshDigest,
      }),
      null
    );
  });

  it("rechecks entitlement authority before consent and code exchange without consuming denied codes", async () => {
    const beforeConsent = await reviewerFixture();
    await pool.query(
      "UPDATE exomem_entitlements SET effective_state = 'cancelled' WHERE tenant_id = $1",
      [beforeConsent.tenantId]
    );
    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: beforeConsent.sessionId,
        transactionDigest: beforeConsent.transactionDigest,
        codeDigest: randomBytes(32),
        codeExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
    const beforeExchange = await reviewerFixture();
    const input = await grantCode(beforeExchange);
    await pool.query(
      "UPDATE exomem_entitlements SET source = 'paddle', provider_transaction_ref = $2, provider_environment = 'sandbox' WHERE tenant_id = $1",
      [beforeExchange.tenantId, `txn_${randomUUID()}`]
    );
    assert.equal(await issueOAuthTokensFromCodeAtomic(input), null);
    const code = await pool.query(
      "SELECT consumed_at FROM exomem_oauth_authorization_codes WHERE code_digest = $1",
      [input.codeDigest]
    );
    assert.equal(code.rows[0].consumed_at, null);
  });

  it("refuses an access token whose family belongs to another admitted client", async () => {
    const fixture = await reviewerFixture();
    const tokens = await authorize(fixture);
    const client = await pool.query(
      "INSERT INTO exomem_oauth_clients (client_id, client_platform, admission_mode, enabled, redirect_uris, redirect_uris_digest, oauth_client_config_sha256) VALUES ($1, 'openai', 'pinned', true, $3::jsonb, digest(convert_to($3::jsonb::text, 'utf8'), 'sha256'), $2) RETURNING id",
      [
        `family-client-${randomUUID()}`,
        randomBytes(32).toString("hex"),
        JSON.stringify([fixture.redirectUri]),
      ]
    );
    await pool.query("UPDATE exomem_oauth_token_families SET client_id = $1 WHERE id = $2", [
      client.rows[0].id,
      tokens.familyId,
    ]);
    assert.equal(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE), null);
  });

  it("keeps runtime health in routing while refusing stopped/deleted cells and blocked/deleted owners", async () => {
    const fixture = await reviewerFixture();
    const tokens = await authorize(fixture);
    await pool.query(
      "UPDATE exomem_cloud_cells SET observed_state = 'failed', ready = false WHERE tenant_id = $1",
      [fixture.tenantId]
    );
    assert.ok(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE));
    assert.ok(await findExomemSessionByDigest(fixture.sessionDigest));
    await pool.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE tenant_id = $1",
      [fixture.tenantId]
    );
    assert.equal(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE), null);
    await pool.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'running' WHERE tenant_id = $1",
      [fixture.tenantId]
    );
    await pool.query(
      "INSERT INTO exomem_oauth_account_blocks (owner_user_id, tenant_id, blocked_reason) VALUES ($1, $2, 'operator_revoked')",
      [fixture.ownerUserId, fixture.tenantId]
    );
    assert.equal(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE), null);
    assert.equal(
      await createCloudReviewerOAuthSessionAtomic({
        ...fixture.sessionInput,
        sessionDigest: randomBytes(32),
      }),
      null
    );
    await pool.query("DELETE FROM exomem_oauth_account_blocks WHERE tenant_id = $1", [
      fixture.tenantId,
    ]);
    await pool.query("UPDATE users SET deleted_at = now() WHERE id = $1", [fixture.ownerUserId]);
    assert.equal(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE), null);
    assert.equal(
      await rotateOAuthRefreshTokenAtomic(refreshInput(fixture, tokens.refreshDigest)),
      null
    );
  });

  it("refuses disabled reviewer flags and Hosted redemption while preserving ordinary Cloud reads", async () => {
    const fixture = await reviewerFixture();
    const tokens = await authorize(fixture);
    for (const key of ["EXOMEM_CLOUD_ENABLED", "EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED"]) {
      process.env[key] = "false";
      assert.equal(await findCloudOAuthAccessToken(tokens.accessDigest, CLOUD_RESOURCE), null);
      assert.equal(await createCloudReviewerOAuthSessionAtomic(fixture.sessionInput), null);
      assert.equal(
        await rotateOAuthRefreshTokenAtomic(refreshInput(fixture, tokens.refreshDigest)),
        null
      );
      process.env[key] = "true";
    }
    const hosted = await insertCredential(fixture, "provider_review", "openai");
    assert.equal(
      await createCloudReviewerOAuthSessionAtomic({
        ...fixture.sessionInput,
        credentialId: hosted.rows[0].id,
        sessionDigest: randomBytes(32),
      }),
      null
    );
  });

  it("rotation invalidates the former tenant lineage and leaves the other provider intact", async () => {
    const previous = await reviewerFixture();
    const previousTokens = await authorize(previous);
    const other = await reviewerFixture("anthropic");
    const otherTokens = await authorize(other);
    const replacement = await reviewerFixture();
    assert.notEqual(replacement.tenantId, previous.tenantId);
    assert.equal(
      await findCloudOAuthAccessToken(previousTokens.accessDigest, CLOUD_RESOURCE),
      null
    );
    assert.equal(await findExomemSessionByDigest(previous.sessionDigest), null);
    assert.ok(await findCloudOAuthAccessToken(otherTokens.accessDigest, CLOUD_RESOURCE));
    assert.ok(await findExomemSessionByDigest(replacement.sessionDigest));
  });

  it("revokes only the selected provider, including sessions and unconsumed transactions/codes, while ordinary access survives", async () => {
    const openai = await reviewerFixture();
    const openaiTokens = await authorize(openai);
    const anthropic = await reviewerFixture("anthropic");
    const anthropicTokens = await authorize(anthropic);
    const ordinary = await sample(false);
    const grant = await pool.query(
      "INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes) VALUES ($1, $2, $3, $4, ARRAY['exomem.read','exomem.write']) RETURNING id",
      [ordinary.ownerUserId, ordinary.tenantId, openai.clientDbId, CLOUD_RESOURCE]
    );
    const family = await pool.query(
      "INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id",
      [grant.rows[0].id, openai.clientDbId]
    );
    const ordinaryAccess = randomBytes(32);
    await pool.query(
      "INSERT INTO exomem_oauth_access_tokens (access_digest, grant_id, family_id, client_id, resource, scopes, expires_at) VALUES ($1, $2, $3, $4, $5, ARRAY['exomem.read','exomem.write'], now() + interval '1 hour')",
      [ordinaryAccess, grant.rows[0].id, family.rows[0].id, openai.clientDbId, CLOUD_RESOURCE]
    );
    assert.equal(
      await revokeCloudReviewerCredentialAtomic({
        provider: "openai",
        operatorPrincipalDigest: randomBytes(32),
      }),
      1
    );
    assert.equal(
      await revokeCloudReviewerCredentialAtomic({
        provider: "openai",
        operatorPrincipalDigest: randomBytes(32),
      }),
      0
    );
    assert.equal(await findExomemSessionByDigest(openai.sessionDigest), null);
    assert.equal(await findCloudOAuthAccessToken(openaiTokens.accessDigest, CLOUD_RESOURCE), null);
    assert.equal(
      await rotateOAuthRefreshTokenAtomic(refreshInput(openai, openaiTokens.refreshDigest)),
      null
    );
    assert.ok(await findCloudOAuthAccessToken(anthropicTokens.accessDigest, CLOUD_RESOURCE));
    assert.ok(await findCloudOAuthAccessToken(ordinaryAccess, CLOUD_RESOURCE));
    assert.ok(
      await rotateOAuthRefreshTokenAtomic(refreshInput(anthropic, anthropicTokens.refreshDigest))
    );
  });

  for (const boundary of ["consent", "redemption", "exchange", "refresh"] as const) {
    for (const winner of ["revoke", "authorization"] as const) {
      it(`serializes ${boundary} against revocation when ${winner} wins the tenant lock`, async () => {
        const fixture = await reviewerFixture();
        const code = boundary === "exchange" ? await grantCode(fixture) : null;
        const tokens = boundary === "refresh" ? await authorize(fixture) : null;
        const operation = () =>
          boundary === "consent"
            ? attachExistingOwnerAuthorizationAtomic({
                sessionId: fixture.sessionId,
                transactionDigest: fixture.transactionDigest,
                codeDigest: randomBytes(32),
                codeExpiresAt: new Date(Date.now() + 60_000),
              })
            : boundary === "redemption"
              ? createCloudReviewerOAuthSessionAtomic({
                  ...fixture.sessionInput,
                  sessionDigest: randomBytes(32),
                })
              : boundary === "exchange"
                ? issueOAuthTokensFromCodeAtomic(code!)
                : rotateOAuthRefreshTokenAtomic(refreshInput(fixture, tokens!.refreshDigest));
        const mutation = {
          consent: "exomem:attach-existing-owner-oauth",
          redemption: "exomem-cloud:redeem-reviewer",
          exchange: "exomem:oauth-code-exchange",
          refresh: "exomem:oauth-refresh-rotate",
        }[boundary];
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const pauseMarker = winner === "revoke" ? "exomem-cloud:revoke-reviewer-lineage" : mutation;
        let paused = false;
        statementBarrier = async (text) => {
          if (!paused && text.includes(pauseMarker)) {
            paused = true;
            held.resolve();
            await release.promise;
          }
        };
        const revoke = () =>
          revokeCloudReviewerCredentialAtomic({
            provider: "openai",
            operatorPrincipalDigest: randomBytes(32),
          });
        const first = winner === "revoke" ? revoke() : operation();
        await held.promise;
        const second = winner === "revoke" ? operation() : revoke();
        let waiting = false;
        try {
          // A real blocked tenant lock, not a timer, establishes the race.
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const waits = await pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF tenant%' AND query LIKE '%' || $1 || '%'",
              [
                winner === "revoke"
                  ? boundary === "exchange"
                    ? "authorization_codes"
                    : boundary === "refresh"
                      ? "refresh_tokens"
                      : boundary === "consent"
                        ? "exomem_sessions"
                        : "marketplace_reviewer_credentials"
                  : "exomem-cloud:lock-reviewer-tenants",
              ]
            );
            if (waits.rows[0]) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally {
          release.resolve();
        }
        const [firstResult, secondResult] = await Promise.all([first, second]);
        statementBarrier = null;
        assert.ok(waiting, "the competing writer must block on the tenant row");
        assert.equal(winner === "revoke" ? firstResult : secondResult, 1);
        if (winner === "revoke") assert.equal(secondResult, null);
        else assert.ok(firstResult);
        assert.equal(await findExomemSessionByDigest(fixture.sessionDigest), null);
        const live = await pool.query(
          "SELECT (SELECT count(*) FROM exomem_sessions WHERE reviewer_credential_id = $1 AND revoked_at IS NULL) + (SELECT count(*) FROM exomem_oauth_authorization_transactions WHERE reviewer_credential_id = $1 AND consumed_at IS NULL) + (SELECT count(*) FROM exomem_oauth_authorization_codes WHERE reviewer_credential_id = $1 AND consumed_at IS NULL) + (SELECT count(*) FROM exomem_oauth_grants WHERE reviewer_credential_id = $1 AND revoked_at IS NULL) + (SELECT count(*) FROM exomem_oauth_token_families WHERE reviewer_credential_id = $1 AND revoked_at IS NULL) + (SELECT count(*) FROM exomem_oauth_refresh_tokens WHERE reviewer_credential_id = $1 AND consumed_at IS NULL) + (SELECT count(*) FROM exomem_oauth_access_tokens WHERE reviewer_credential_id = $1 AND revoked_at IS NULL) AS count",
          [fixture.credentialId]
        );
        assert.equal(Number(live.rows[0].count), 0);
      });
    }
  }
});
