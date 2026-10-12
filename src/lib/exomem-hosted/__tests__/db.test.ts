import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  createMagicAccessToken,
  findExomemSessionByDigest,
  recordExomemCheckoutTransaction,
  consumeDeletionConfirmationAtomic,
  createInviteRecord,
  takeRateLimit,
  withExomemTransaction,
  type ExomemSql,
} from "../db";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

describe("Exomem hosted database boundary", () => {
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

  it("serializes reviewer invite issuance and refuses blocked owner authority", async () => {
    const statements: string[] = [];
    const sql: ExomemSql = async (strings) => {
      const statement = strings.join("?");
      statements.push(statement);
      if (statement.includes("exomem-cloud:capacity")) {
        const capacity = { fresh_observations: 1, fresh_slots: 3, live_cells: 0 };
        const row = { ...capacity, outstanding_invitations: 0, newest_observation_at: null };
        return { rows: [row], rowCount: 1 };
      }
      return statement.includes("pg_advisory_xact_lock")
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
    const insert = statements.find((statement) => statement.includes("INSERT INTO exomem_invites"));
    assert.match(insert!, /exomem_oauth_account_blocks/i);
    assert.match(insert!, /tenant\.status = 'deletion_pending'/i);
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
      return { rows: [{ id: "018f2d91-7c42-7000-8000-000000000063" }], rowCount: 1 };
    });

    const result = await consumeDeletionConfirmationAtomic({
      userId: "018f2d91-7c42-7000-8000-000000000061",
      tenantId: "018f2d91-7c42-7000-8000-000000000062",
      tokenDigest: Buffer.alloc(32, 0x63),
    });

    assert.equal(result, true);
    assert.match(statement, /FOR UPDATE OF token, tenant/i);
    assert.match(statement, /purpose = 'deletion_confirmation'/i);
    assert.match(statement, /SET status = 'deletion_pending'/i);
    assert.match(statement, /UPDATE exomem_sessions/i);
    assert.match(statement, /UPDATE exomem_entitlements/i);
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
