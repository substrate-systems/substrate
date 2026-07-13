import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  __setExomemSqlForTests,
  createMagicAccessToken,
  recordExomemCheckoutTransaction,
  consumeDeletionConfirmationAtomic,
  redeemInviteAtomic,
  resolveActiveCellBinding,
  takeRateLimit,
  type ExomemSql,
} from "../db";

afterEach(() => __setExomemSqlForTests(null));

describe("Exomem hosted database boundary", () => {
  it("redeems through one atomic statement and concurrent replay creates no second tenant", async () => {
    let consumed = false;
    let queryCount = 0;
    let capturedSql = "";
    const sql: ExomemSql = async (strings) => {
      queryCount += 1;
      capturedSql = strings.join("?");
      await Promise.resolve();
      if (consumed) return { rows: [], rowCount: 0 };
      consumed = true;
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

    const params = {
      tokenDigest: Buffer.alloc(32, 1),
      sessionDigest: Buffer.alloc(32, 2),
      csrfDigest: Buffer.alloc(32, 3),
      sessionExpiresAt: new Date("2026-07-13T00:00:00.000Z"),
    };
    const results = await Promise.all([redeemInviteAtomic(params), redeemInviteAtomic(params)]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(new Set(results.filter(Boolean).map((row) => row?.tenantId)).size, 1);
    assert.equal(queryCount, 2, "one database statement per redemption attempt");
    assert.match(capturedSql, /FOR UPDATE/i);
    assert.match(capturedSql, /INSERT INTO users/i);
    assert.match(capturedSql, /INSERT INTO exomem_tenants/i);
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

  it("allows magic-link authentication before deletion begins", async () => {
    const statements: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      statements.push(strings.join("?"));
      return { rows: [], rowCount: 0 };
    });
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
    for (const statement of statements) {
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
