import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, __setExomemTransactionForTests } from "../db";
import {
  demoteOperatorClientArtifact,
  createReviewerOAuthBootstrapAuthority,
  listOperatorClientArtifacts,
  listOperatorOAuthClients,
  listReviewerOAuthBootstrapAuthorities,
  preflightRecoverExpiredReviewerCleanup,
  preflightRecoverTerminalReviewerDelete,
  recoverTerminalReviewerDelete,
  recoverExpiredReviewerCleanup,
  registerOperatorOAuthClient,
  revokeOperatorOAuthAccount,
  revokeOperatorOAuthFamily,
  setOperatorOAuthClientEnabled,
} from "../operator-controls";
import { exomemContractFixture0572 } from "../gateway-contract-0-57-2";
import { operatorOAuthClientFingerprint } from "../oauth-client-admission";

const originalControlPlaneKey = process.env.EXOMEM_CONTROL_PLANE_KEY;

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
  if (originalControlPlaneKey === undefined) delete process.env.EXOMEM_CONTROL_PLANE_KEY;
  else process.env.EXOMEM_CONTROL_PLANE_KEY = originalControlPlaneKey;
});

describe("hosted operator controls", () => {
  it("stages a virgin bootstrap authority against the exact 0.57.2 gateway contract", async () => {
    const values: unknown[] = [];
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    __setExomemTransactionForTests(async (work) =>
      work(async (strings, ...parameters) => {
        values.push(...parameters);
        return strings.join("?").includes("create-reviewer-oauth-bootstrap-authority")
          ? { rows: [{ id: "018f2d91-7c42-7000-8000-000000000079", expires_at: expiresAt }] }
          : { rows: [] };
      })
    );

    assert.deepEqual(
      await createReviewerOAuthBootstrapAuthority({
        inviteId: "018f2d91-7c42-7000-8000-000000000071",
        stagedClientReleaseId: "018f2d91-7c42-7000-8000-000000000072",
        oauthClientId: "018f2d91-7c42-7000-8000-000000000073",
        expiresAt,
        operatorPrincipalDigest: Buffer.alloc(32, 0x49),
      }),
      { id: "018f2d91-7c42-7000-8000-000000000079", expiresAt: expiresAt.toISOString() }
    );
    assert.equal(values.includes(exomemContractFixture0572.release), true);
    assert.equal(values.includes(exomemContractFixture0572.digest), true);
  });

  it("requires every reviewer and OAuth issuer to take the cohort lock before authority admission", () => {
    const reviewerIssuer = readFileSync(
      resolve(process.cwd(), "src/lib/exomem-hosted/reviewer-access-store.ts"),
      "utf8"
    );
    const oauthIssuer = readFileSync(
      resolve(process.cwd(), "src/lib/exomem-hosted/oauth-store.ts"),
      "utf8"
    );
    assert.match(
      reviewerIssuer,
      /createMarketplaceReviewerOAuthSessionAtomic[\s\S]*?pg_advisory_xact_lock_shared\(hashtext\('exomem-hosted-alpha-cohort'\)\)/
    );
    assert.match(
      oauthIssuer,
      /async function withCohortLock[\s\S]*?pg_advisory_xact_lock_shared\(hashtext\('exomem-hosted-alpha-cohort'\)\)/
    );
    assert.match(oauthIssuer, /resolveApprovedOAuthClient[\s\S]*?return withCohortLock\(/);
  });

  it("locks and atomically recovers only the caller-pinned expired reviewer cleanup", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      return query.includes("recover-expired-reviewer-cleanup")
        ? {
            rows: [
              {
                outcome: "enqueued",
                operation_id: "018f2d91-7c42-7000-8000-000000000002",
              },
            ],
          }
        : { rows: [] };
    };
    __setExomemTransactionForTests(async (work) => work(sql));
    const sourceOperationId = "018f2d91-7c42-7000-8000-000000000001";

    assert.deepEqual(
      await recoverExpiredReviewerCleanup({
        sourceOperationId,
        expectedFence: 7,
        requestId: "018f2d91-7c42-7000-8000-000000000003",
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      }),
      { outcome: "enqueued", operationId: "018f2d91-7c42-7000-8000-000000000002" }
    );
    assert.match(queries[0]!, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    const mutation = queries[1]!;
    assert.match(mutation, /operation_type IN \('provision', 'restore'\)/i);
    assert.match(mutation, /state IN \('waiting', 'failed_retryable'\)/i);
    assert.match(mutation, /checkpoint = 'candidate-cleanup'/i);
    assert.match(mutation, /lease_expires_at IS NULL OR source\.lease_expires_at <= now\(\)/i);
    assert.match(mutation, /marketplace_reviewer_purpose = true/i);
    assert.match(mutation, /bound_cell_id IS NULL/i);
    assert.match(mutation, /COUNT\(\*[\s\S]*?\) = 1/i);
    assert.match(mutation, /assignment\.expires_at <= now\(\)/i);
    assert.match(mutation, /assignment\.state = 'failed' AND assignment\.ended_at IS NOT NULL/i);
    assert.match(mutation, /exomem_oauth_account_blocks/i);
    assert.match(mutation, /exomem_sessions/i);
    assert.match(mutation, /exomem_transfer_grants/i);
    assert.match(
      mutation,
      /JOIN users AS owner ON owner\.id = tenant_gated\.owner_user_id[\s\S]*invite\.email_normalized = owner\.email/i
    );
    assert.match(mutation, /exomem_marketplace_reviewer_credentials/i);
    assert.match(mutation, /exomem_marketplace_reviewer_oauth_bootstrap_authorities/i);
    assert.match(mutation, /exomem_oauth_authorization_transactions/i);
    assert.match(mutation, /exomem_oauth_authorization_codes/i);
    assert.match(mutation, /exomem_oauth_grants/i);
    assert.match(mutation, /exomem_oauth_token_families/i);
    assert.match(mutation, /exomem_oauth_access_tokens/i);
    assert.match(mutation, /exomem_oauth_refresh_tokens/i);
    assert.match(
      mutation,
      /grant_row\.tenant_id IN \(SELECT id FROM tenant_gated\)[\s\S]*?grant_row\.candidate_id = source\.target_candidate_id/i
    );
    assert.match(mutation, /DELETION_SUPERSEDED/i);
    assert.match(mutation, /target_candidate_id.*NULL/i);
    assert.match(mutation, /exomem_audit_events/i);
    assert.match(mutation, /digest\(convert_to\(source\.id::text/i);
  });

  it("preflights the same boundary without any mutation clauses", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [{ eligible: true }] };
    };
    __setExomemSqlForTests(sql);

    assert.deepEqual(
      await preflightRecoverExpiredReviewerCleanup({
        sourceOperationId: "018f2d91-7c42-7000-8000-000000000001",
        expectedFence: 7,
      }),
      { eligible: true }
    );
    assert.match(query, /candidate-cleanup/i);
    assert.match(query, /assignment\.state = 'failed' AND assignment\.ended_at IS NOT NULL/i);
    assert.doesNotMatch(query, /\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
  });

  it("preflights and reopens only the owner-confirmed terminal provider-proven reviewer delete", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      return query.includes("/* exomem:recover-terminal-reviewer-delete */")
        ? { rows: [{ outcome: "enqueued", operation_id: "018f2d91-7c42-7000-8000-000000000001" }] }
        : { rows: [{ eligible: true }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));
    const operationId = "018f2d91-7c42-7000-8000-000000000001";

    assert.deepEqual(
      await preflightRecoverTerminalReviewerDelete({ operationId, expectedFence: 7 }),
      { eligible: true }
    );
    assert.match(queries[0]!, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    assert.doesNotMatch(queries[1]!, /(?:^|\n)\s*(?:UPDATE|INSERT|DELETE)\s+/i);
    assert.match(queries[1]!, /confirmation\.purpose = 'deletion_confirmation'/i);
    assert.match(queries[1]!, /confirmation\.consumed_at IS NOT NULL/i);
    assert.match(queries[1]!, /confirmation\.user_id = tenant\.owner_user_id/i);
    assert.match(queries[1]!, /'confirmed-deletion-' \|\| confirmation\.id::text/i);
    assert.doesNotMatch(queries[1]!, /operator\.reviewer_cleanup\.(?:authorized|delete_enqueued)/i);

    assert.deepEqual(
      await recoverTerminalReviewerDelete({
        operationId,
        expectedFence: 7,
        requestId: "018f2d91-7c42-7000-8000-000000000003",
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      }),
      { outcome: "enqueued", operationId }
    );
    assert.match(queries[2]!, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    const mutation = queries[3]!;
    assert.match(mutation, /operation_type = 'delete'/i);
    assert.match(mutation, /state = 'failed_terminal'/i);
    assert.match(mutation, /error_code = 'LIFECYCLE_MAX_ATTEMPTS'/i);
    assert.match(mutation, /checkpoint = 'destroyed'/i);
    assert.match(mutation, /checkpoint = 'destroyed'/i);
    assert.doesNotMatch(mutation, /provider_result_ref IS NOT NULL/i);
    assert.match(mutation, /exomem_access_tokens AS confirmation/i);
    assert.match(mutation, /confirmation\.purpose = 'deletion_confirmation'/i);
    assert.match(mutation, /confirmation\.consumed_at IS NOT NULL/i);
    assert.match(mutation, /confirmation\.user_id = operation\.tenant_owner_user_id/i);
    assert.match(mutation, /idempotency_key = 'confirmed-deletion-' \|\| confirmation\.id::text/i);
    assert.match(
      mutation,
      /operation\.cell_id IS NULL AND operation\.expected_previous_cell_id IS NULL/i
    );
    assert.match(mutation, /source\.cell_id = cell\.id/i);
    assert.doesNotMatch(mutation, /operator\.reviewer_cleanup\.(?:authorized|delete_enqueued)/i);
    assert.match(
      mutation,
      /assignment\.gateway_contract_digest = source\.target_gateway_contract_digest/i
    );
    assert.match(
      mutation,
      /assignment\.compatibility_digest = source\.target_compatibility_digest/i
    );
    assert.match(mutation, /candidate\.schema_digest = source\.target_schema_digest/i);
    assert.match(mutation, /bootstrap\.candidate_contract_digest = candidate\.schema_digest/i);
    assert.match(
      mutation,
      /bootstrap\.candidate_compatibility_digest = source\.target_compatibility_digest/i
    );
    assert.match(mutation, /allocation\.state = 'uncertain'/i);
    assert.match(mutation, /DELETION_SUPERSEDED/i);
    assert.match(mutation, /state = 'consumed'/i);
    assert.match(mutation, /operator\.terminal_reviewer_delete\.authorized/i);
    assert.match(mutation, /operator\.terminal_reviewer_delete\.replayed/i);
    assert.match(mutation, /attempts = 0/i);
    assert.match(mutation, /lease_owner = NULL/i);
    assert.doesNotMatch(mutation, /INSERT INTO exomem_lifecycle_operations/i);
    assert.doesNotMatch(mutation, /UPDATE exomem_capacity_allocations/i);
  });

  it("permits pending client registration only through an exact current staged declaration", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000091", enabled: false }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    await registerOperatorOAuthClient({
      admissionMode: "pinned",
      platform: "claude",
      clientId: "desktop-client",
      redirectUris: ["https://app.example.test/callback"],
      stagedClientReleaseId: "018f2d91-7c42-7000-8000-000000000090",
    });

    assert.match(queries[1]!, /exomem_staged_client_releases/i);
    assert.match(queries[1]!, /state IN \('staged', 'evidenced'\)/i);
    assert.match(queries[1]!, /expires_at > now\(\)/i);
    assert.match(queries[1]!, /oauth_client_config_sha256/i);
  });

  it("lists approved clients without returning their raw client identity or redirects", async () => {
    const controlPlaneKey = Buffer.alloc(32, 0x51);
    process.env.EXOMEM_CONTROL_PLANE_KEY = controlPlaneKey.toString("base64url");
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          id: "018f2d91-7c42-7000-8000-000000000001",
          client_id: "https://private.example/credential-sentinel",
          enabled: true,
          admission_mode: "pinned",
          redirect_uris_digest: Buffer.alloc(32, 0x22),
          redirect_count: 2,
          metadata_expires_at: null,
        },
      ],
    }));

    assert.deepEqual(await listOperatorOAuthClients(), [
      {
        id: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
        admissionMode: "pinned",
        clientFingerprint: operatorOAuthClientFingerprint(
          "https://private.example/credential-sentinel",
          controlPlaneKey
        ),
        redirectDigest: Buffer.alloc(32, 0x22).toString("hex"),
        redirectCount: 2,
        metadataExpiresAt: null,
      },
    ]);
  });

  it("returns the consumed bootstrap assignment generation without private client data", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        {
          id: "018f2d91-7c42-7000-8000-000000000001",
          state: "consumed",
          expires_at: new Date("2026-08-12T00:00:00.000Z"),
          outcome_tenant_id: "tenant-1",
          outcome_assignment_id: "assignment-1",
          outcome_assignment_generation: 1,
          outcome_operation_id: "operation-1",
          outcome_session_id: "session-1",
          outcome_grant_id: "grant-1",
        },
      ],
    }));

    assert.equal(
      (await listReviewerOAuthBootstrapAuthorities())[0]?.outcomeAssignmentGeneration,
      1
    );
  });

  it("changes exactly one opaque client record", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000001" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: false,
      }),
      true
    );
    assert.match(query, /WHERE client\.id = \?::uuid/i);
  });

  it("does not enable a client from staged authority alone", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
      }),
      false
    );
    assert.doesNotMatch(query, /exomem_staged_client_releases/i);
    assert.match(query, /exomem_client_artifacts/i);
    assert.match(query, /client\.reviewer_bootstrap_ever_authorized = false/i);
  });

  it("never re-enables a client with bootstrap history, including a null legacy config", async () => {
    let query = "";
    const sql = async (strings: TemplateStringsArray) => {
      query = strings.join("?");
      return { rows: [] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    assert.equal(
      await setOperatorOAuthClientEnabled({
        clientRecordId: "018f2d91-7c42-7000-8000-000000000001",
        enabled: true,
      }),
      false
    );
    assert.match(
      query,
      /\(\? = false\) OR \(\s*client\.reviewer_bootstrap_ever_authorized = false AND EXISTS/i
    );
  });

  it("fences family and account revocation to the named owner and tenant", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      return query.includes("revoke-oauth-account-for-owner-tenant")
        ? { rows: [{ revoked_families: 1 }] }
        : { rows: [{ id: "018f2d91-7c42-7000-8000-000000000002" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));
    const ownerUserId = "018f2d91-7c42-7000-8000-000000000010";
    const tenantId = "018f2d91-7c42-7000-8000-000000000011";

    assert.equal(
      await revokeOperatorOAuthFamily({
        ownerUserId,
        tenantId,
        familyId: "018f2d91-7c42-7000-8000-000000000012",
      }),
      true
    );
    assert.equal(await revokeOperatorOAuthAccount({ ownerUserId, tenantId }), 1);
    assert.match(queries[0], /oauth_grant\.user_id = \?/i);
    assert.match(queries[0], /oauth_grant\.tenant_id = \?/i);
    assert.match(queries[1], /exomem_oauth_account_blocks/i);
    assert.match(queries[1], /FOR UPDATE/i);
  });

  it("reports artifact digests only and demotes live artifacts to retired", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT id, platform")) {
        return {
          rows: [
            {
              id: "018f2d91-7c42-7000-8000-000000000020",
              platform: "claude",
              state: "live",
              package_sha256: "a".repeat(64),
              archive_sha256: "b".repeat(64),
              compatibility_sha256: "c".repeat(64),
              contract_sha256: "d".repeat(64),
            },
          ],
        };
      }
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000020" }] };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (callback) => callback(sql));

    const artifacts = await listOperatorClientArtifacts();
    assert.equal(artifacts[0]?.packageSha256, "a".repeat(64));
    assert.equal(JSON.stringify(artifacts).includes("install"), false);
    assert.equal(await demoteOperatorClientArtifact("018f2d91-7c42-7000-8000-000000000020"), true);
    assert.match(queries[1], /pg_advisory_xact_lock\(/i);
    assert.doesNotMatch(queries[1], /pg_advisory_xact_lock_shared/i);
    assert.match(queries[2], /SET state = 'retired', retired_at = now\(\)/i);
    assert.match(queries[2], /state = 'live'/i);
  });
});
