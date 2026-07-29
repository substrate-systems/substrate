import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  createMarketplaceReviewerSessionAtomic,
  createMarketplaceReviewerOAuthSessionAtomic,
  createOrRotateMarketplaceReviewerCredentialAtomic,
  bindMarketplaceReviewerCredentialToOAuthTransactionAtomic,
  getMarketplaceReviewerCredentialStatus,
  revokeMarketplaceReviewerCredentialAtomic,
} from "../reviewer-access-store";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

function setSql(sql: ExomemSql): void {
  __setExomemSqlForTests(sql);
  __setExomemTransactionForTests(async (callback) => callback(sql));
}

test("creation validates a usable pre-bound owner and atomically rotates only the provider credential", async () => {
  const queries: string[] = [];
  setSql(async (strings) => {
    const query = strings.join("?");
    queries.push(query);
    return { rows: [{ id: "credential-1", owner_user_id: "owner-1", tenant_id: "tenant-1" }] };
  });

  const created = await createOrRotateMarketplaceReviewerCredentialAtomic({
    provider: "openai",
    usernameDigest: Buffer.alloc(32, 1),
    passwordHash: "$argon2id$test",
    ownerUserId: "owner-1",
    tenantId: "tenant-1",
    fixtureVersion: "review-fixture-v1",
    fixturePayloadDigest: "a".repeat(64),
    expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    operatorPrincipalDigest: Buffer.alloc(32, 2),
  });

  assert.deepEqual(created, {
    credentialId: "credential-1",
    ownerUserId: "owner-1",
    tenantId: "tenant-1",
  });
  const query = queries.join("\n");
  assert.match(query, /FOR UPDATE/i);
  assert.match(query, /JOIN users/i);
  assert.match(query, /JOIN exomem_entitlements/i);
  assert.match(query, /JOIN exomem_cells/i);
  assert.match(query, /marketplace_reviewer_purpose = true/i);
  assert.match(query, /exomem_oauth_account_blocks/i);
  assert.match(query, /UPDATE exomem_marketplace_reviewer_credentials/i);
  assert.match(query, /INSERT INTO exomem_marketplace_reviewer_credentials/i);
  assert.match(query, /fixture_payload_digest/i);
  assert.match(query, /UPDATE exomem_oauth_grants/i);
  assert.match(query, /grants_revoked[\s\S]*reviewer_transactions/i);
  assert.match(query, /revocation_complete[\s\S]*access_revoked/i);
  assert.match(query, /FROM target CROSS JOIN revocation_complete/i);
  assert.doesNotMatch(
    query,
    /INSERT INTO exomem_tenants|INSERT INTO exomem_entitlements|INSERT INTO exomem_cells/i
  );
  assert.doesNotMatch(query, /exomem_oauth_account_blocks\s*\(/i);
});

test("an unusable rotation target cannot revoke the current provider credential", async () => {
  let query = "";
  setSql(async (strings) => {
    query = strings.join("?");
    return { rows: [] };
  });

  assert.equal(
    await createOrRotateMarketplaceReviewerCredentialAtomic({
      provider: "openai",
      usernameDigest: Buffer.alloc(32, 1),
      passwordHash: "$argon2id$test",
      ownerUserId: "unusable-owner",
      tenantId: "unusable-tenant",
      fixtureVersion: "review-fixture-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      operatorPrincipalDigest: Buffer.alloc(32, 2),
    }),
    null
  );
  assert.match(
    query,
    /prior AS \([\s\S]*?FROM target[\s\S]*?exomem_marketplace_reviewer_credentials/i
  );
  assert.match(query, /credential_revoked AS \([\s\S]*?FROM prior/i);
});

test("reviewer OAuth binding maps Anthropic to Claude and excludes cross-provider clients", async () => {
  let query = "";
  setSql(async (strings) => {
    query = strings.join("?");
    return { rows: [{ id: "transaction-1" }] };
  });

  assert.equal(
    await bindMarketplaceReviewerCredentialToOAuthTransactionAtomic({
      credentialId: "credential-1",
      sessionId: "session-1",
      transactionDigest: Buffer.alloc(32, 8),
    }),
    true
  );
  assert.match(query, /transaction\.transaction_digest = \?/i);
  assert.match(
    query,
    /\(credential\.provider = 'anthropic' AND client\.client_platform = 'claude'\)[\s\S]*\(credential\.provider = 'openai' AND client\.client_platform = 'openai'\)/i
  );
  assert.match(query, /session\.reviewer_credential_id = credential\.id/i);
  assert.match(query, /transaction\.consumed_at IS NULL/i);
});

test("reviewer sessions are tagged to the credential without provisioning", async () => {
  let query = "";
  setSql(async (strings) => {
    query = strings.join("?");
    return { rows: [{ id: "session-1", user_id: "owner-1", tenant_id: "tenant-1" }] };
  });

  assert.deepEqual(
    await createMarketplaceReviewerSessionAtomic({
      credentialId: "credential-1",
      sessionDigest: Buffer.alloc(32, 3),
      csrfDigest: Buffer.alloc(32, 4),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    }),
    { sessionId: "session-1", ownerUserId: "owner-1", tenantId: "tenant-1" }
  );
  assert.match(query, /reviewer_credential_id/i);
  assert.match(query, /INSERT INTO exomem_sessions/i);
  assert.match(query, /LEAST\(\?, credential\.expires_at\)/i);
  assert.doesNotMatch(
    query,
    /INSERT INTO users|INSERT INTO exomem_tenants|INSERT INTO exomem_entitlements|INSERT INTO exomem_cells/i
  );
});

test("reviewer OAuth session creation atomically binds the matching provider transaction", async () => {
  const queries: string[] = [];
  setSql(async (strings) => {
    queries.push(strings.join("?"));
    return { rows: [{ id: "session-1" }] };
  });

  assert.deepEqual(
    await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: "credential-1",
      transactionDigest: Buffer.alloc(32, 8),
      sessionDigest: Buffer.alloc(32, 3),
      csrfDigest: Buffer.alloc(32, 4),
      expiresAt: new Date("2026-08-01T00:00:00.000Z"),
    }),
    { sessionId: "session-1" }
  );
  const query = queries.join("\n");
  assert.match(
    query,
    /SELECT credential\.id, credential\.owner_user_id, credential\.tenant_id, credential\.expires_at, credential\.provider/i
  );
  assert.match(query, /INSERT INTO exomem_sessions/i);
  assert.match(query, /UPDATE exomem_oauth_authorization_transactions/i);
  assert.match(
    query,
    /\(credential\.provider = 'anthropic' AND client\.client_platform = 'claude'\)[\s\S]*\(credential\.provider = 'openai' AND client\.client_platform = 'openai'\)/i
  );
  assert.match(query, /reviewer_credential_id = credential\.id/i);
  assert.match(query, /pg_advisory_xact_lock_shared\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
  assert.match(query, /exomem_hosted_alpha_cohort/i);
  assert.match(
    query,
    /client\.oauth_client_config_sha256 = cohort\.claude_oauth_client_config_sha256/i
  );
  assert.match(
    query,
    /client\.oauth_client_config_sha256 = cohort\.openai_oauth_client_config_sha256/i
  );
  assert.doesNotMatch(
    query,
    /INSERT INTO users|INSERT INTO exomem_tenants|INSERT INTO exomem_entitlements|INSERT INTO exomem_cells/i
  );
});

test("credential creation rejects an unbounded expiry before mutating reviewer state", async () => {
  let calls = 0;
  setSql(async () => {
    calls += 1;
    return { rows: [] };
  });

  await assert.rejects(
    createOrRotateMarketplaceReviewerCredentialAtomic({
      provider: "openai",
      usernameDigest: Buffer.alloc(32, 1),
      passwordHash: "$argon2id$test",
      ownerUserId: "owner-1",
      tenantId: "tenant-1",
      fixtureVersion: "review-fixture-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      operatorPrincipalDigest: Buffer.alloc(32, 2),
    })
  );
  assert.equal(calls, 0);
});

test("status is sanitized and revocation is idempotent without an account block", async () => {
  const queries: string[] = [];
  setSql(async (strings) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("reviewer-credential-status")) {
      return {
        rows: [
          {
            provider: "openai",
            fixture_version: "review-fixture-v1",
            fixture_payload_digest: "a".repeat(64),
            expires_at: "2026-08-01T00:00:00.000Z",
            revoked_at: null,
          },
        ],
      };
    }
    return { rows: [{ revoked_credentials: 0 }] };
  });

  const status = await getMarketplaceReviewerCredentialStatus("openai");
  assert.deepEqual(status, {
    provider: "openai",
    fixtureVersion: "review-fixture-v1",
    fixturePayloadDigest: "a".repeat(64),
    expiresAt: "2026-08-01T00:00:00.000Z",
    revokedAt: null,
  });
  assert.equal(JSON.stringify(status).includes("password"), false);
  assert.equal(
    await revokeMarketplaceReviewerCredentialAtomic({
      provider: "openai",
      operatorPrincipalDigest: Buffer.alloc(32, 5),
    }),
    0
  );
  const query = queries.join("\n");
  assert.match(query, /UPDATE exomem_sessions/i);
  assert.match(query, /UPDATE exomem_oauth_authorization_transactions/i);
  assert.match(query, /UPDATE exomem_oauth_authorization_codes/i);
  assert.match(query, /UPDATE exomem_oauth_grants/i);
  assert.match(query, /UPDATE exomem_oauth_token_families/i);
  assert.match(query, /UPDATE exomem_oauth_access_tokens/i);
  assert.match(query, /grants_revoked[\s\S]*reviewer_transactions/i);
  assert.doesNotMatch(query, /INSERT INTO exomem_oauth_account_blocks/i);
});
