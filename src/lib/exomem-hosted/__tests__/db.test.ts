import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeTransferGrantRecord,
  createMagicAccessToken,
  findExomemSessionByDigest,
  createTransferGrantRecord,
  recordExomemCheckoutTransaction,
  consumeDeletionConfirmationAtomic,
  createInviteRecord,
  redeemInviteAtomic,
  resolveActiveCellBinding,
  takeRateLimit,
  withExomemTransaction,
  type ExomemSql,
} from "../db";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

describe("Exomem hosted database boundary", () => {
  it("keeps OAuth first-owner admission outside legacy-unmetered redemption", () => {
    const oauthStore = readFileSync(
      resolve(process.cwd(), "src/lib/exomem-hosted/oauth-store.ts"),
      "utf8"
    );
    assert.doesNotMatch(oauthStore, /redeemInviteAtomic/);
    assert.doesNotMatch(oauthStore, /admitFirstOAuthInviteAtomicLegacy/);
    assert.match(oauthStore, /withExomemTransaction/);
  });

  it("never treats an injected HTTP SQL client as an interactive transaction", async () => {
    let called = false;
    __setExomemSqlForTests(async () => ({ rows: [] }));
    await assert.rejects(
      withExomemTransaction(async () => {
        called = true;
      }),
      /interactive Exomem transaction runner is not configured/
    );
    assert.equal(called, false);
  });

  it("prunes expired tenant transfer audit rows while issuing a replacement", async () => {
    const statements: string[] = [];
    const testSql: ExomemSql = async (strings) => {
      statements.push(strings.join("?"));
      return { rows: [{ id: "grant-1" }], rowCount: 1 };
    };
    __setExomemSqlForTests(testSql);
    __setExomemTransactionForTests(async (work) => work(testSql));

    assert.deepEqual(
      await createTransferGrantRecord({
        grantDigest: Buffer.alloc(32, 1),
        tenantId: "018f2d91-7c42-7000-8000-000000000081",
        cellId: "018f2d91-7c42-7000-8000-000000000082",
        userId: "018f2d91-7c42-7000-8000-000000000083",
        principalScopeDigest: Buffer.alloc(32, 2),
        operation: "upload",
        issuedAt: new Date("2026-07-14T12:00:00.000Z"),
        expiresAt: new Date("2026-07-14T12:05:00.000Z"),
        byteLimit: 1024,
      }),
      { grantId: "grant-1" }
    );
    assert.match(statements[0]!, /pg_advisory_xact_lock_shared/i);
    const statement = statements[1]!;
    assert.match(statement, /DELETE FROM exomem_transfer_grants/i);
    assert.match(statement, /expires_at <= now\(\)/i);
    assert.match(statement, /tenant_id =/i);
    assert.match(statement, /INSERT INTO exomem_transfer_grants/i);
  });

  it("serializes transfer consumption and rechecks the tenant deletion gate", async () => {
    const statements: string[] = [];
    const testSql: ExomemSql = async (strings) => {
      statements.push(strings.join("?"));
      return { rows: [{ id: "grant-1" }], rowCount: 1 };
    };
    __setExomemSqlForTests(testSql);
    __setExomemTransactionForTests(async (work) => work(testSql));

    assert.equal(
      await consumeTransferGrantRecord({
        grantId: "grant-1",
        tenantId: "018f2d91-7c42-7000-8000-000000000081",
        cellId: "018f2d91-7c42-7000-8000-000000000082",
        operation: "upload",
      }),
      true
    );
    assert.match(statements[0]!, /pg_advisory_xact_lock_shared/i);
    assert.match(statements[1]!, /FROM exomem_tenants AS tenant/i);
    assert.match(statements[1]!, /tenant\.status = 'active'/i);
    assert.match(statements[1]!, /tenant\.desired_state = 'running'/i);
    assert.match(statements[1]!, /exomem_oauth_account_blocks/i);
  });

  it("keeps the explicitly documented legacy-unmetered redemption branch separate from OAuth admission", async () => {
    let inviteClaimed = false;
    let queryCount = 0;
    let lockCount = 0;
    let capturedSql = "";
    const sql: ExomemSql = async (strings) => {
      queryCount += 1;
      const statement = strings.join("?");
      if (statement.includes("pg_advisory_xact_lock_shared")) {
        lockCount += 1;
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*SELECT id, email_normalized, entitlement_source/.test(statement)) {
        if (inviteClaimed) return { rows: [], rowCount: 0 };
        inviteClaimed = true;
        return {
          rows: [
            {
              id: "invite-1",
              email_normalized: "ordinary@example.test",
              entitlement_source: "complimentary",
              entitlement_capabilities: [],
              entitlement_limits: {},
              marketplace_reviewer_purpose: false,
            },
          ],
          rowCount: 1,
        };
      }
      capturedSql = statement;
      await Promise.resolve();
      return {
        rows: [
          {
            user_id: "user-1",
            tenant_id: "tenant-1",
            session_id: "session-1",
            operation_id: "operation-1",
          },
        ],
        rowCount: 1,
      };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    const params = {
      tokenDigest: Buffer.alloc(32, 1),
      sessionDigest: Buffer.alloc(32, 2),
      csrfDigest: Buffer.alloc(32, 3),
      sessionExpiresAt: new Date("2026-07-13T00:00:00.000Z"),
    };
    const results = await Promise.all([redeemInviteAtomic(params), redeemInviteAtomic(params)]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(new Set(results.filter(Boolean).map((row) => row?.tenantId)).size, 1);
    assert.equal(queryCount, 5, "each attempt classifies the invite before selecting its branch");
    assert.equal(lockCount, 2);
    assert.match(capturedSql, /FOR UPDATE/i);
    assert.match(capturedSql, /INSERT INTO users/i);
    assert.match(capturedSql, /INSERT INTO exomem_tenants/i);
    assert.match(
      capturedSql,
      /legacy_unmetered, marketplace_reviewer_purpose\s*\)\s*SELECT[\s\S]*true/i
    );
    assert.doesNotMatch(
      capturedSql,
      /ON CONFLICT \(owner_user_id\) DO UPDATE[\s\S]{0,240}legacy_unmetered/i
    );
    assert.match(capturedSql, /INSERT INTO exomem_entitlements/i);
    assert.match(capturedSql, /ON CONFLICT \(tenant_id\) DO NOTHING/i);
    assert.doesNotMatch(
      capturedSql,
      /ON CONFLICT \(tenant_id\) DO UPDATE[\s\S]{0,240}effective_state/i
    );
    assert.match(capturedSql, /INSERT INTO exomem_sessions/i);
    assert.match(capturedSql, /INSERT INTO exomem_lifecycle_operations/i);
    assert.match(capturedSql, /UPDATE exomem_invites/i);
    assert.match(capturedSql, /expires_at > now\(\)/i);
  });

  it("propagates immutable invitation purpose into new tenants and refuses mismatched reuse", async () => {
    const statements: string[] = [];
    const sql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (/^\s*SELECT id, email_normalized, entitlement_source/.test(statement)) {
        return {
          rows: [
            {
              id: "invite-1",
              email_normalized: "reviewer@example.test",
              entitlement_source: "complimentary",
              entitlement_capabilities: [],
              entitlement_limits: {},
              marketplace_reviewer_purpose: true,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };
    __setExomemSqlForTests(sql);
    __setExomemTransactionForTests(async (work) => work(sql));

    await redeemInviteAtomic({
      tokenDigest: Buffer.alloc(32, 1),
      sessionDigest: Buffer.alloc(32, 2),
      csrfDigest: Buffer.alloc(32, 3),
      sessionExpiresAt: new Date("2026-07-13T00:00:00.000Z"),
    });

    const statement = statements.find((candidate) => /locked_invite/i.test(candidate)) ?? "";
    assert.match(statement, /locked_invite[\s\S]*marketplace_reviewer_purpose/i);
    assert.match(
      statement,
      /INSERT INTO exomem_tenants \(\s*owner_user_id, status, desired_state, legacy_unmetered, marketplace_reviewer_purpose\s*\)/i
    );
    assert.match(
      statement,
      /exomem_tenants\.marketplace_reviewer_purpose = EXCLUDED\.marketplace_reviewer_purpose/i
    );
    assert.match(statement, /status <> 'deletion_pending'/i);
    assert.match(statement, /exomem_oauth_account_blocks/i);
  });

  it("keeps ordinary invite issuance outside reviewer cohort serialization", async () => {
    let transactionUsed = false;
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "invite-1" }], rowCount: 1 };
    });
    __setExomemTransactionForTests(async (work) => {
      transactionUsed = true;
      return work(async () => ({ rows: [{ id: "invite-1" }], rowCount: 1 }));
    });

    assert.deepEqual(
      await createInviteRecord({
        tokenDigest: Buffer.alloc(32, 1),
        emailNormalized: "ordinary@example.test",
        entitlementSource: "complimentary",
        capabilities: [],
        resourceLimits: {},
        operatorPrincipalDigest: Buffer.alloc(32, 2),
        expiresAt: new Date("2026-07-13T00:00:00.000Z"),
      }),
      { inviteId: "invite-1" }
    );
    assert.equal(transactionUsed, false);
    assert.match(statement, /INSERT INTO exomem_invites/i);
  });

  it("serializes paid operator invites against hard and outstanding capacity", async () => {
    const statements: string[] = [];
    const transactionSql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (statement.includes("paid-operator-invite-pool")) {
        return {
          rows: [
            {
              storage_capacity_bytes: 10_737_418_240,
              reserved_storage_bytes: 0,
              runtime_capacity_slots: 2,
              reserved_runtime_slots: 0,
              provision_reservation_capacity: 2,
              reserved_provision_slots: 0,
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("paid-operator-invite-outstanding")) {
        return { rows: [{ outstanding: 1 }], rowCount: 1 };
      }
      return { rows: [{ id: "invite-paid" }], rowCount: 1 };
    };
    __setExomemTransactionForTests(async (work) => work(transactionSql));

    assert.deepEqual(
      await createInviteRecord({
        tokenDigest: Buffer.alloc(32, 1),
        emailNormalized: "paid@example.test",
        entitlementSource: "paddle",
        capabilities: [],
        resourceLimits: {},
        operatorPrincipalDigest: Buffer.alloc(32, 2),
        expiresAt: new Date("2026-07-13T00:00:00.000Z"),
      }),
      { inviteId: "invite-paid" }
    );

    assert.match(statements[0]!, /paid-operator-invite-pool[\s\S]*FOR UPDATE/i);
    assert.match(
      statements[1]!,
      /paid-operator-invite-outstanding[\s\S]*entitlement_source = 'paddle'[\s\S]*NOT self_serve[\s\S]*delivery_state IN \('pending', 'sent'\)/i
    );
    assert.match(statements[2]!, /INSERT INTO exomem_invites/i);
  });

  it("refuses a paid operator invite when every capacity slot is promised", async () => {
    let inserts = 0;
    const transactionSql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      if (statement.includes("paid-operator-invite-pool")) {
        return {
          rows: [
            {
              storage_capacity_bytes: 5_368_709_120,
              reserved_storage_bytes: 0,
              runtime_capacity_slots: 1,
              reserved_runtime_slots: 0,
              provision_reservation_capacity: 1,
              reserved_provision_slots: 0,
            },
          ],
          rowCount: 1,
        };
      }
      if (statement.includes("paid-operator-invite-outstanding")) {
        return { rows: [{ outstanding: 1 }], rowCount: 1 };
      }
      inserts += 1;
      return { rows: [{ id: "unexpected" }], rowCount: 1 };
    };
    __setExomemTransactionForTests(async (work) => work(transactionSql));

    await assert.rejects(
      createInviteRecord({
        tokenDigest: Buffer.alloc(32, 1),
        emailNormalized: "full@example.test",
        entitlementSource: "paddle",
        capabilities: [],
        resourceLimits: {},
        operatorPrincipalDigest: Buffer.alloc(32, 2),
        expiresAt: new Date("2026-07-13T00:00:00.000Z"),
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CAPACITY_UNAVAILABLE"
    );
    assert.equal(inserts, 0);
  });

  it("serializes reviewer invite issuance and refuses blocked owner authority", async () => {
    const statements: string[] = [];
    const sql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      statements.push(statement);
      return statement.includes("pg_advisory_xact_lock_shared")
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: "invite-1" }], rowCount: 1 };
    };
    __setExomemTransactionForTests(async (work) => work(sql));

    await createInviteRecord({
      tokenDigest: Buffer.alloc(32, 1),
      emailNormalized: "reviewer@example.test",
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: true,
      operatorPrincipalDigest: Buffer.alloc(32, 2),
      expiresAt: new Date("2026-07-13T00:00:00.000Z"),
    });
    assert.match(statements[0]!, /pg_advisory_xact_lock_shared/i);
    assert.match(statements[1]!, /exomem_oauth_account_blocks/i);
    assert.match(statements[1]!, /tenant\.status = 'deletion_pending'/i);
  });

  it("uses the same invitation purpose guard for capacity-aware OAuth admission", () => {
    const oauthStore = readFileSync(
      resolve(process.cwd(), "src/lib/exomem-hosted/oauth-store.ts"),
      "utf8"
    );
    assert.match(oauthStore, /entitlement_limits,\s*marketplace_reviewer_purpose/i);
    assert.match(
      oauthStore,
      /tenant\.marketplace_reviewer_purpose = \$\{invite\.marketplace_reviewer_purpose\}/i
    );
    assert.match(
      oauthStore,
      /INSERT INTO exomem_tenants \(\s*owner_user_id, status, desired_state, marketplace_reviewer_purpose\s*\)/i
    );
  });

  it("rejects expired or revoked reviewer-attributed sessions without changing ordinary session lookup", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [] };
    });
    await findExomemSessionByDigest(Buffer.alloc(32, 9));
    assert.match(statement, /LEFT JOIN exomem_marketplace_reviewer_credentials/i);
    assert.match(statement, /session\.reviewer_credential_id IS NULL/i);
    assert.match(statement, /reviewer_credential\.revoked_at IS NULL/i);
    assert.match(statement, /reviewer_credential\.expires_at > now\(\)/i);
    assert.match(statement, /tenant\.status IN \('provisioning', 'active', 'suspended'\)/i);
    assert.match(statement, /exomem_oauth_account_blocks/i);
  });

  it("allows magic-link authentication before deletion begins", async () => {
    const statements: string[] = [];
    const testSql: ExomemSql = async (strings) => {
      statements.push(strings.join("?"));
      return { rows: [], rowCount: 0 };
    };
    __setExomemSqlForTests(testSql);
    __setExomemTransactionForTests(async (work) => work(testSql));
    const { createMagicAccessToken, redeemMagicAccessTokenAtomic } = await import("../db");
    await createMagicAccessToken({
      emailNormalized: "owner@example.com",
      tokenDigest: Buffer.alloc(32, 4),
      browserChallengeDigest: Buffer.alloc(32, 7),
      expiresAt: new Date("2026-07-13T00:00:00.000Z"),
      deliverySecretCiphertext: {
        version: 1,
        algorithm: "A256GCM",
        iv: "iv",
        ciphertext: "ciphertext",
        tag: "tag",
      },
    });
    await redeemMagicAccessTokenAtomic({
      tokenDigest: Buffer.alloc(32, 4),
      browserChallengeDigest: Buffer.alloc(32, 7),
      sessionDigest: Buffer.alloc(32, 5),
      csrfDigest: Buffer.alloc(32, 6),
      sessionExpiresAt: new Date("2026-07-14T00:00:00.000Z"),
    });
    assert.equal(
      statements.some((statement) =>
        /pg_advisory_xact_lock_shared\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i.test(statement)
      ),
      true
    );
    for (const statement of statements.filter(
      (value) => !value.includes("pg_advisory_xact_lock_shared")
    )) {
      assert.match(statement, /tenant\.status IN \('provisioning', 'active', 'suspended'\)/i);
      assert.doesNotMatch(statement, /effective_state IN \('active', 'grace'\)/i);
      assert.doesNotMatch(statement, /deletion_pending/i);
    }
    assert.match(statements[0], /INSERT INTO exomem_access_delivery_outbox/i);
  });

  it("fails closed when active cell lookup is ambiguous", async () => {
    __setExomemSqlForTests(async () => ({
      rows: [
        { id: "cell-1", tenant_id: "tenant-1" },
        { id: "cell-2", tenant_id: "tenant-1" },
      ],
      rowCount: 2,
    }));
    await assert.rejects(
      () => resolveActiveCellBinding("tenant-1"),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "CELL_MAPPING_AMBIGUOUS"
    );
  });

  it("publishes a candidate through one atomic expected-binding swap", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return {
        rows: [{ cell_id: "cell-new", previous_cell_id: "cell-old" }],
        rowCount: 1,
      };
    });
    const { bindActiveCellAtomic } = await import("../db");
    const result = await bindActiveCellAtomic({
      tenantId: "tenant-1",
      candidateCellId: "cell-new",
      expectedPreviousCellId: "cell-old",
    });
    assert.deepEqual(result, {
      cellId: "cell-new",
      previousCellId: "cell-old",
    });
    assert.match(statement, /FOR UPDATE/i);
    assert.match(statement, /FROM exomem_tenants/i);
    assert.match(statement, /SET bound_cell_id = swap_guard\.candidate_id/i);
    assert.match(statement, /SET routing_state = 'retiring'/i);
    assert.match(statement, /SET routing_state = 'bound'/i);
    assert.match(statement, /expected-binding|expectedPreviousCellId|previous_id/i);
  });

  it("serializes two initial candidates on the tenant binding row", async () => {
    let boundCell: string | null = null;
    let calls = 0;
    __setExomemSqlForTests(async (_strings, ...values) => {
      calls += 1;
      const candidateCellId = String(values[1]);
      await Promise.resolve();
      if (boundCell !== null) return { rows: [], rowCount: 0 };
      boundCell = candidateCellId;
      return {
        rows: [{ cell_id: candidateCellId, previous_cell_id: null }],
        rowCount: 1,
      };
    });
    const { bindActiveCellAtomic } = await import("../db");
    const results = await Promise.all([
      bindActiveCellAtomic({
        tenantId: "tenant-1",
        candidateCellId: "cell-a",
        expectedPreviousCellId: null,
      }),
      bindActiveCellAtomic({
        tenantId: "tenant-1",
        candidateCellId: "cell-b",
        expectedPreviousCellId: null,
      }),
    ]);
    assert.equal(calls, 2);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(boundCell === "cell-a" || boundCell === "cell-b", true);
  });

  it("binds a checkout transaction only through owner, tenant, and Paddle entitlement state", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "entitlement-1" }], rowCount: 1 };
    });

    assert.equal(
      await recordExomemCheckoutTransaction({
        userId: "018f2d91-7c42-7000-8000-000000000061",
        tenantId: "018f2d91-7c42-7000-8000-000000000062",
        transactionId: "txn_01kxatbjfrehbp0sxbjefcacqs",
        environment: "sandbox",
      }),
      true
    );
    assert.match(statement, /tenant\.owner_user_id/i);
    assert.match(statement, /entitlement\.source = 'paddle'/i);
    assert.match(statement, /provider_transaction_ref IS NULL/i);
    assert.match(statement, /provider_environment/i);
    assert.match(statement, /FOR UPDATE OF tenant/i);
    assert.match(statement, /status IN \('provisioning', 'active', 'suspended'\)/i);
  });

  it("consumes deletion confirmation and gates only Exomem rows in one transaction", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return {
        rows: [
          {
            id: "018f2d91-7c42-7000-8000-000000000063",
            request_id: "018f2d91-7c42-7000-8000-000000000064",
          },
        ],
        rowCount: 1,
      };
    });

    const result = await consumeDeletionConfirmationAtomic({
      userId: "018f2d91-7c42-7000-8000-000000000061",
      tenantId: "018f2d91-7c42-7000-8000-000000000062",
      tokenDigest: Buffer.alloc(32, 0x63),
    });

    assert.ok(result);
    assert.match(statement, /FOR UPDATE OF token, tenant/i);
    assert.match(statement, /purpose = 'deletion_confirmation'/i);
    assert.match(statement, /SET status = 'deletion_pending'/i);
    assert.match(statement, /UPDATE exomem_sessions/i);
    assert.match(statement, /UPDATE exomem_transfer_grants/i);
    assert.match(statement, /UPDATE exomem_entitlements/i);
    assert.match(statement, /UPDATE exomem_exports/i);
    assert.match(statement, /SET state = 'failed_terminal'/i);
    assert.match(statement, /DELETION_SUPERSEDED/i);
    assert.match(statement, /operation_type, idempotency_key/i);
    assert.doesNotMatch(statement, /FROM operation\s+JOIN sessions_revoked/i);
    assert.doesNotMatch(statement, /DELETE FROM users/i);
    assert.doesNotMatch(statement, /UPDATE users/i);
  });

  it("serializes each rate-limit bucket before count-and-insert", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ allowed: true }], rowCount: 1 };
    });

    assert.equal(
      await takeRateLimit({
        scope: "exomem_magic_account",
        keyDigest: "a".repeat(64),
        limit: 5,
        windowSeconds: 3600,
      }),
      true
    );
    assert.match(statement, /INSERT INTO exomem_rate_limit_buckets/i);
    assert.match(statement, /ON CONFLICT \(scope, key_digest\) DO UPDATE/i);
    assert.match(statement, /admitted_count </i);
  });

  it("defines bounded stale rate-limit pruning", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/exomem-hosted/db.ts"), "utf8");
    assert.match(source, /exomem:prune-stale-rate-limit-buckets/);
    assert.match(source, /updated_at\s*<=\s*now\(\)\s*-\s*\(/i);
    assert.match(source, /LIMIT\s+\$\{/i);
    assert.match(source, /DELETE FROM exomem_rate_limit_buckets/i);
  });

  it("revokes older browser-bound magic tokens before creating a replacement", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "token-new", email_normalized: "owner@example.com" }], rowCount: 1 };
    });
    await createMagicAccessToken({
      emailNormalized: "owner@example.com",
      tokenDigest: Buffer.alloc(32, 0x51),
      browserChallengeDigest: Buffer.alloc(32, 0x52),
      expiresAt: new Date("2026-07-14T12:00:00.000Z"),
      deliverySecretCiphertext: {
        version: 1,
        algorithm: "A256GCM",
        iv: "iv",
        ciphertext: "ciphertext",
        tag: "tag",
      },
    });
    assert.match(statement, /UPDATE exomem_access_tokens/i);
    assert.match(statement, /purpose = 'magic_link'/i);
    assert.match(statement, /revoked_at = COALESCE/i);
    assert.match(statement, /browser_challenge_digest/i);
  });
});
