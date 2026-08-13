import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  createMarketplaceReviewerSessionAtomic,
  createMarketplaceReviewerOAuthSessionAtomic,
  createInternalCanaryReviewerCredentialAtomic,
  createOrRotateMarketplaceReviewerCredentialAtomic,
  bindMarketplaceReviewerCredentialToOAuthTransactionAtomic,
  findMarketplaceReviewerCredentialForAuthentication,
  getMarketplaceReviewerCredentialStatus,
  getInternalCanaryReviewerCredentialStatus,
  revokeInternalCanaryReviewerCredentialAtomic,
  revokeMarketplaceReviewerCredentialAtomic,
} from "../reviewer-access-store";

// Reviewer credential expiry is validated against a window relative to now, so a
// literal date stops being valid the moment it passes. These fixtures held until
// 2026-08-01 and failed every run after it. Derive it from the clock instead.
const EXPIRES_AT = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

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
    return {
      rows: [
        {
          id: "credential-1",
          owner_user_id: "owner-1",
          tenant_id: "tenant-1",
          expires_at: EXPIRES_AT,
        },
      ],
    };
  });

  const created = await createOrRotateMarketplaceReviewerCredentialAtomic({
    provider: "openai",
    usernameDigest: Buffer.alloc(32, 1),
    passwordHash: "$argon2id$test",
    ownerUserId: "owner-1",
    tenantId: "tenant-1",
    fixtureVersion: "review-fixture-v1",
    fixturePayloadDigest: "a".repeat(64),
    expiresAt: new Date(EXPIRES_AT),
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
  assert.match(query, /exomem_client_artifacts/i);
  assert.match(query, /artifact\.state = 'live'/i);
  assert.match(query, /exomem_oauth_account_blocks/i);
  assert.match(query, /UPDATE exomem_marketplace_reviewer_credentials/i);
  assert.match(query, /INSERT INTO exomem_marketplace_reviewer_credentials/i);
  assert.match(query, /fixture_payload_digest/i);
  assert.match(query, /UPDATE exomem_oauth_grants/i);
  assert.match(query, /grants_revoked[\s\S]*reviewer_transactions/i);
  assert.match(
    query,
    /setup_sessions_revoked[\s\S]*tenant_id IN \(SELECT tenant_id FROM target\)/i
  );
  assert.match(query, /setup_sessions_revoked[\s\S]*reviewer_credential_id IS NULL/i);
  assert.match(
    query,
    /setup_transactions AS \([\s\S]*redeemed_session_id IN \(SELECT id FROM setup_sessions_revoked\)/i
  );
  assert.match(query, /setup_grants_revoked[\s\S]*reviewer_credential_id IS NULL/i);
  assert.match(query, /setup_codes_consumed[\s\S]*setup_grants_revoked/i);
  assert.match(query, /setup_families_revoked[\s\S]*reviewer_setup_sealed/i);
  assert.match(query, /setup_refresh_consumed[\s\S]*setup_families_revoked/i);
  assert.match(query, /setup_access_revoked[\s\S]*setup_grants_revoked/i);
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
      expiresAt: new Date(EXPIRES_AT),
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

test("internal canary issuance seals invite setup state and binds exact staged authority", async () => {
  const queries: string[] = [];
  setSql(async (strings) => {
    queries.push(strings.join("?"));
    return {
      rows: [
        {
          id: "credential-1",
          owner_user_id: "owner-1",
          tenant_id: "tenant-1",
          expires_at: EXPIRES_AT,
        },
      ],
    };
  });

  assert.deepEqual(
    await createInternalCanaryReviewerCredentialAtomic({
      platform: "claude",
      usernameDigest: Buffer.alloc(32, 1),
      passwordHash: "$argon2id$test",
      tenantId: "tenant-1",
      candidateId: "candidate-1",
      assignmentId: "assignment-1",
      assignmentGeneration: 3,
      stagedClientReleaseId: "stage-1",
      oauthClientId: "client-1",
      fixtureVersion: "internal-canary-v1",
      fixturePayloadDigest: "a".repeat(64),
      expiresAt: new Date(EXPIRES_AT),
      operatorPrincipalDigest: Buffer.alloc(32, 2),
    }),
    {
      credentialId: "credential-1",
      ownerUserId: "owner-1",
      tenantId: "tenant-1",
      expiresAt: EXPIRES_AT,
    }
  );
  const query = queries.join("\n");
  assert.match(
    query,
    /provider, credential_kind[\s\S]*candidate_id, assignment_id, assignment_generation/i
  );
  assert.match(query, /credential_kind = 'internal_canary'/i);
  assert.match(
    query,
    /bootstrap\.state = 'consumed'[\s\S]*bootstrap\.outcome_tenant_id = tenant\.id[\s\S]*bootstrap\.outcome_assignment_id = assignment\.id/i
  );
  assert.match(query, /SELECT id, owner_user_id, tenant_id, expires_at FROM created/i);
  assert.match(
    query,
    /prior_sessions_revoked[\s\S]*reviewer_credential_id IN \(SELECT id FROM prior_revoked\)/i
  );
  assert.match(query, /prior_refresh_consumed[\s\S]*prior_families_revoked/i);
  assert.match(query, /assignment\.state IN \('preparing', 'active'\)/i);
  assert.match(query, /stage\.candidate_id = assignment\.candidate_id/i);
  assert.doesNotMatch(query, /AND client\.enabled/i);
  assert.match(query, /setup_sessions_revoked[\s\S]*exomem_invites AS invite/i);
  assert.match(query, /invite\.redeemed_session_id/i);
  assert.match(query, /setup_transactions AS \([\s\S]*SELECT transaction\.id/i);
  assert.match(
    query,
    /setup_grants_revoked[\s\S]*authorization_transaction_id IN \(SELECT id FROM setup_transactions\)/i
  );
  assert.match(query, /setup_families_revoked[\s\S]*reviewer_setup_sealed/i);
  assert.match(query, /exomem-hosted-alpha-cohort/i);
  assert.match(query, /exomem-marketplace-reviewer-access/i);
  assert.ok(
    queries.findIndex((value) => value.includes("exomem-hosted-alpha-cohort")) <
      queries.findIndex((value) => value.includes("exomem-marketplace-reviewer-access"))
  );
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
      expiresAt: new Date(EXPIRES_AT),
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
      expiresAt: new Date(EXPIRES_AT),
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
            expires_at: EXPIRES_AT,
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
    expiresAt: EXPIRES_AT,
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
  assert.match(query, /UPDATE exomem_oauth_refresh_tokens/i);
  assert.match(query, /UPDATE exomem_oauth_access_tokens/i);
  assert.match(query, /grants_revoked[\s\S]*reviewer_transactions/i);
  assert.doesNotMatch(query, /INSERT INTO exomem_oauth_account_blocks/i);
});

test("internal canary status and revocation require the exact lineage and exclude provider status", async () => {
  const queries: string[] = [];
  setSql(async (strings) => {
    const query = strings.join("?");
    queries.push(query);
    if (query.includes("internal-canary-reviewer-credential-status")) {
      return {
        rows: [
          {
            client_platform: "claude",
            fixture_version: "internal-canary-v1",
            fixture_payload_digest: "a".repeat(64),
            expires_at: EXPIRES_AT,
            revoked_at: null,
          },
        ],
      };
    }
    if (query.includes("reviewer-credential-status")) {
      return {
        rows: [
          {
            provider: "openai",
            fixture_version: "provider-review-v1",
            fixture_payload_digest: "b".repeat(64),
            expires_at: EXPIRES_AT,
            revoked_at: null,
          },
        ],
      };
    }
    if (query.includes("lock-internal-canary-reviewer-credential"))
      return { rows: [{ id: "credential-1" }] };
    return { rows: [{ revoked_credentials: 1 }] };
  });

  const selector = {
    platform: "claude" as const,
    tenantId: "018f2d91-7c42-7000-8000-000000000011",
    candidateId: "018f2d91-7c42-7000-8000-000000000012",
    assignmentId: "018f2d91-7c42-7000-8000-000000000013",
    assignmentGeneration: 2,
    stagedClientReleaseId: "018f2d91-7c42-7000-8000-000000000014",
    oauthClientId: "018f2d91-7c42-7000-8000-000000000015",
  };
  assert.equal(
    (await getMarketplaceReviewerCredentialStatus("openai"))?.fixtureVersion,
    "provider-review-v1"
  );
  assert.deepEqual(await getInternalCanaryReviewerCredentialStatus(selector), {
    credentialKind: "internal_canary",
    platform: "claude",
    fixtureVersion: "internal-canary-v1",
    fixturePayloadDigest: "a".repeat(64),
    expiresAt: EXPIRES_AT,
    revokedAt: null,
  });
  assert.equal(
    await revokeInternalCanaryReviewerCredentialAtomic({
      ...selector,
      operatorPrincipalDigest: Buffer.alloc(32, 5),
    }),
    1
  );
  const query = queries.join("\n");
  assert.match(query, /credential_kind = 'provider_review'/i);
  assert.match(query, /credential_kind = 'internal_canary'/i);
  assert.match(query, /oauth_client_id = \?::uuid/i);
  assert.match(query, /client\.client_platform = \?/i);
  assert.match(query, /exomem:revoke-canary-oauth-lineage/i);
  assert.doesNotMatch(query, /password_hash[\s\S]*internal-canary-reviewer-credential-status/i);
});

test("normalizes PostgreSQL Date timestamps for reviewer lookup and status", async () => {
  const expiresAt = new Date(EXPIRES_AT);
  const revokedAt = new Date("2026-07-31T00:00:00.000Z");
  setSql(async (strings) => {
    const query = strings.join("?");
    if (query.includes("find-marketplace-reviewer-credential")) {
      return {
        rows: [
          {
            id: "credential-1",
            provider: "openai",
            owner_user_id: "owner-1",
            tenant_id: "tenant-1",
            fixture_version: "review-fixture-v1",
            password_hash: "$argon2id$test",
            expires_at: expiresAt,
            revoked_at: null,
          },
        ],
      };
    }
    return {
      rows: [
        {
          provider: "openai",
          fixture_version: "review-fixture-v1",
          fixture_payload_digest: "a".repeat(64),
          expires_at: expiresAt,
          revoked_at: revokedAt,
        },
      ],
    };
  });

  const authentication = await findMarketplaceReviewerCredentialForAuthentication(
    Buffer.alloc(32, 9)
  );
  assert.deepEqual(authentication?.expiresAt, EXPIRES_AT);
  assert.deepEqual(authentication?.revokedAt, null);
  const status = await getMarketplaceReviewerCredentialStatus("openai");
  assert.deepEqual(status?.expiresAt, EXPIRES_AT);
  assert.deepEqual(status?.revokedAt, "2026-07-31T00:00:00.000Z");
});
