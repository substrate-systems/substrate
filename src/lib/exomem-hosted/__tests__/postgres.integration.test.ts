import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  claimMagicLinkDelivery,
  clearExomemCheckoutTransaction,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  createMagicAccessToken,
  markMagicLinkDeliverySent,
  pruneStaleRateLimitBuckets,
  rateLimitHasRoom,
  recordExomemCheckoutTransaction,
  redeemMagicAccessTokenAtomic,
  releaseMagicLinkDelivery,
  takeRateLimit,
  type ExomemSql,
} from "../db";
import { createSqlExomemPaddleEventStore, type ExomemPaddleSql } from "../paddle-event-store";
import type { ExomemPaddleEventApplication } from "../paddle-webhook";
import {
  claimPaddleReconciliationTargets,
  releasePaddleReconciliationLease,
} from "../paddle-reconciliation-runtime";

// A past_due event seals email 04's payload inside the Paddle projection.
process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";

async function waitForBlockedQuery(pool: Pool, marker: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE pid <> pg_backend_pid()
           AND query LIKE $1
           AND wait_event_type = 'Lock'
       ) AS waiting`,
      [`%${marker}%`]
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`query did not block on ${marker}`);
}

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    const text = strings.reduce(
      (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
      ""
    );
    const result = await client.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

function paidActivationApplication(input: {
  eventId: string;
  transactionId: string;
}): ExomemPaddleEventApplication {
  return {
    eventId: input.eventId,
    eventType: "subscription.created",
    environment: "sandbox",
    origin: "webhook",
    revision: {
      occurredAt: "2026-07-13T06:13:03.661Z",
      eventId: input.eventId,
    },
    correlation: {
      productKey: "exomem-hosted",
      userId: USER,
      tenantId: TENANT,
    },
    sourceState: "active",
    capabilities: ["capture", "recall", "export"],
    resourceLimits: {
      storageBytes: 5 * 1024 * 1024 * 1024,
      uploadBytes: 100 * 1024 * 1024,
      workerCount: 0,
    },
    providerReferences: {
      customerId: `ctm_${input.eventId}`,
      subscriptionId: `sub_${input.eventId}`,
      transactionId: input.transactionId,
      productId: "pro_atomic_fresh",
      priceId: "pri_atomic_fresh",
    },
    subscriptionCarriesFriendPrice: false,
    subscriptionFacts: {
      priceName: null,
      nextBilledAt: null,
      discountId: null,
      scheduledChangeAt: null,
    },
  };
}

describe("real PostgreSQL hosted contracts", { skip: !DATABASE_URL }, () => {
  let pool: Pool;

  async function interactiveTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
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

  // Own schema, own migrations, like every other suite in this CI step. This one used
  // to assume a hand-migrated `public`, which was invisible for as long as it never ran
  // in CI; the isolation also keeps its `TRUNCATE ... CASCADE` off other suites' rows
  // when the runner schedules them together.
  before(async () => {
    const schema = `hosted_contracts_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(DATABASE_URL!);
    const admin = new Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(DATABASE_URL!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString(), max: 12 });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE users CASCADE");
    await pool.query("TRUNCATE TABLE exomem_oauth_clients CASCADE");
    await pool.query("TRUNCATE TABLE rate_limit_events");
    await pool.query("TRUNCATE TABLE exomem_rate_limit_buckets");
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool.end();
  });

  it("serializes a burst so the rate limit cannot over-admit", async () => {
    const admitted = await Promise.all(
      Array.from({ length: 20 }, () =>
        takeRateLimit({
          scope: "exomem:postgres-integration",
          keyDigest: "a".repeat(64),
          limit: 5,
          windowSeconds: 60,
        })
      )
    );
    assert.equal(admitted.filter(Boolean).length, 5);
    const count = await pool.query<{ admitted_count: number }>(
      "SELECT admitted_count FROM exomem_rate_limit_buckets WHERE scope = $1",
      ["exomem:postgres-integration"]
    );
    assert.equal(count.rows[0]?.admitted_count, 5);
  });

  // A limit that counts only failures reads the bucket before each attempt. If
  // the read disagreed with the take, a lapsed window would refuse forever, or a
  // full one would admit.
  it("reads a bucket's room as the next take would find it", async () => {
    const bucket = {
      scope: "exomem:postgres-integration-room",
      keyDigest: "c".repeat(64),
      limit: 2,
      windowSeconds: 60,
    };
    assert.equal(await rateLimitHasRoom(bucket), true, "a missing bucket has room");
    await takeRateLimit(bucket);
    assert.equal(await rateLimitHasRoom(bucket), true);
    await takeRateLimit(bucket);
    assert.equal(await rateLimitHasRoom(bucket), false, "a full window has none");
    assert.equal(await takeRateLimit(bucket), false);
    await pool.query(
      "UPDATE exomem_rate_limit_buckets SET window_started_at = now() - interval '61 seconds' WHERE scope = $1",
      [bucket.scope]
    );
    assert.equal(await rateLimitHasRoom(bucket), true, "a lapsed window has room again");
    assert.equal(await takeRateLimit(bucket), true);
  });

  it("prunes only stale limiter buckets in bounded batches", async () => {
    await pool.query(
      `INSERT INTO exomem_rate_limit_buckets
         (scope, key_digest, window_started_at, admitted_count, updated_at)
       VALUES
         ('stale', $1, now() - interval '3 hours', 1, now() - interval '3 hours'),
         ('fresh', $2, now(), 1, now())`,
      ["a".repeat(64), "b".repeat(64)]
    );
    assert.equal(await pruneStaleRateLimitBuckets(2 * 60 * 60, 1), 1);
    const rows = await pool.query<{ scope: string }>(
      "SELECT scope FROM exomem_rate_limit_buckets ORDER BY scope"
    );
    assert.deepEqual(rows.rows, [{ scope: "fresh" }]);
  });

  it("commits a fresh Paddle projection with a terminal receipt so retries are duplicates", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'provisioning', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state,
         capabilities, resource_limits, provider_environment, provider_transaction_ref
       ) VALUES ($1, 'paddle', 'awaiting_checkout', 'provisioning', '[]', '{}', 'sandbox', $2)`,
      [TENANT, "txn_atomic_fresh"]
    );
    const sql: ExomemPaddleSql = async (strings, ...values) => {
      const text = strings.reduce(
        (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
        ""
      );
      const result = await pool.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
    const store = createSqlExomemPaddleEventStore(sql);
    const application = paidActivationApplication({
      eventId: "evt_atomic_fresh",
      transactionId: "txn_atomic_fresh",
    });

    assert.deepEqual(await store.applyVerifiedEventAndMarkProcessedAtomically(application), {
      outcome: "applied",
    });
    assert.deepEqual(await store.applyVerifiedEventAndMarkProcessedAtomically(application), {
      outcome: "duplicate",
    });

    const receipt = await pool.query<{
      disposition: string;
      applied_at: Date | null;
      receipt_count: string;
    }>(
      `SELECT disposition, applied_at,
              count(*) OVER ()::text AS receipt_count
         FROM exomem_paddle_events
        WHERE paddle_event_id = $1`,
      [application.eventId]
    );
    assert.equal(receipt.rows[0]?.disposition, "applied");
    assert.ok(receipt.rows[0]?.applied_at);
    assert.equal(receipt.rows[0]?.receipt_count, "1");
    const entitlement = await pool.query<{
      source_state: string;
      effective_state: string;
      provider_subscription_ref: string | null;
    }>(
      `SELECT source_state, effective_state, provider_subscription_ref
         FROM exomem_entitlements
        WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.deepEqual(entitlement.rows[0], {
      source_state: "active",
      effective_state: "provisioning",
      provider_subscription_ref: "sub_evt_atomic_fresh",
    });
  });

  it("serializes checkout binding against deletion on the tenant row", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state, capabilities, resource_limits
       ) VALUES ($1, 'paddle', 'awaiting_checkout', 'provisioning', '[]', '{}')`,
      [TENANT]
    );

    const deletion = await pool.connect();
    try {
      await deletion.query("BEGIN");
      await deletion.query(
        `UPDATE exomem_tenants
            SET status = 'deletion_pending', desired_state = 'deleted'
          WHERE id = $1`,
        [TENANT]
      );
      const record = recordExomemCheckoutTransaction({
        userId: USER,
        tenantId: TENANT,
        transactionId: `txn_${"a".repeat(26)}`,
        environment: "sandbox",
      });
      await waitForBlockedQuery(pool, "exomem:record-checkout-transaction");
      await deletion.query("COMMIT");
      assert.equal(await record, false);
    } finally {
      await deletion.query("ROLLBACK").catch(() => undefined);
      deletion.release();
    }

    const state = await pool.query<{ provider_transaction_ref: string | null }>(
      "SELECT provider_transaction_ref FROM exomem_entitlements WHERE tenant_id = $1",
      [TENANT]
    );
    assert.equal(state.rows[0]?.provider_transaction_ref, null);
  });

  it("retains a bind-first checkout for deletion cancellation", async () => {
    const transactionId = `txn_${"b".repeat(26)}`;
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state, capabilities, resource_limits
       ) VALUES ($1, 'paddle', 'awaiting_checkout', 'provisioning', '[]', '{}')`,
      [TENANT]
    );

    assert.equal(
      await recordExomemCheckoutTransaction({
        userId: USER,
        tenantId: TENANT,
        transactionId,
        environment: "sandbox",
      }),
      true
    );
    await pool.query(
      `UPDATE exomem_tenants
          SET status = 'deletion_pending', desired_state = 'deleted'
        WHERE id = $1`,
      [TENANT]
    );
    const state = await pool.query<{
      provider_environment: string;
      provider_transaction_ref: string;
      source_state: string;
    }>(
      `SELECT provider_environment, provider_transaction_ref, source_state
       FROM exomem_entitlements WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.deepEqual(state.rows[0], {
      provider_environment: "sandbox",
      provider_transaction_ref: transactionId,
      source_state: "checkout_pending",
    });
  });

  it("does not clear checkout state over a concurrently promoted subscription", async () => {
    const transactionId = `txn_${"c".repeat(26)}`;
    const subscriptionId = `sub_${"d".repeat(26)}`;
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state, capabilities, resource_limits,
         source_revision, provider_environment, provider_transaction_ref
       ) VALUES ($1, 'paddle', 'checkout_pending', 'provisioning', '[]', '{}',
                 'before-promotion', 'sandbox', $2)`,
      [TENANT, transactionId]
    );
    await pool.query(
      `UPDATE exomem_entitlements
          SET provider_subscription_ref = $1, source_revision = 'after-promotion'
        WHERE tenant_id = $2`,
      [subscriptionId, TENANT]
    );

    assert.equal(
      await clearExomemCheckoutTransaction({
        userId: USER,
        tenantId: TENANT,
        transactionId,
        environment: "sandbox",
      }),
      false
    );
    const retained = await pool.query<{
      provider_subscription_ref: string;
      provider_transaction_ref: string;
      source_revision: string;
    }>(
      `SELECT provider_subscription_ref, provider_transaction_ref, source_revision
       FROM exomem_entitlements WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.deepEqual(retained.rows[0], {
      provider_subscription_ref: subscriptionId,
      provider_transaction_ref: transactionId,
      source_revision: "after-promotion",
    });
  });

  it("advances Paddle source state without reopening a deletion-pending entitlement", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'deletion_pending', 'deleted')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state,
         capabilities, resource_limits, source_revision, source_occurred_at,
         provider_environment, provider_subscription_ref
       ) VALUES (
         $1, 'paddle', 'cancelled', 'deleted', '[]', '{}',
         'evt_before_deletion', '2026-07-13T06:20:00Z', 'sandbox', $2
       )`,
      [TENANT, "sub_deletion_pending"]
    );
    const sql: ExomemPaddleSql = async (strings, ...values) => {
      const text = strings.reduce(
        (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
        ""
      );
      const result = await pool.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
    const store = createSqlExomemPaddleEventStore(sql);

    assert.deepEqual(
      await store.applyVerifiedEventAndMarkProcessedAtomically({
        eventId: "evt_after_deletion_started",
        eventType: "subscription.updated",
        environment: "sandbox",
        origin: "webhook",
        revision: {
          occurredAt: "2026-07-13T06:30:00Z",
          eventId: "evt_after_deletion_started",
        },
        correlation: {
          productKey: "exomem-hosted",
          userId: USER,
          tenantId: TENANT,
        },
        sourceState: "active",
        capabilities: ["capture", "recall", "export"],
        resourceLimits: {
          storageBytes: 5 * 1024 * 1024 * 1024,
          uploadBytes: 100 * 1024 * 1024,
          workerCount: 0,
        },
        providerReferences: {
          customerId: "ctm_after_deletion_started",
          subscriptionId: "sub_deletion_pending",
          transactionId: null,
          productId: "pro_after_deletion_started",
          priceId: "pri_after_deletion_started",
        },
        subscriptionCarriesFriendPrice: false,
        subscriptionFacts: {
          priceName: null,
          nextBilledAt: null,
          discountId: null,
          scheduledChangeAt: null,
        },
      }),
      { outcome: "applied" }
    );

    const entitlement = await pool.query<{
      source_state: string;
      source_revision: string | null;
      effective_state: string;
      capabilities: string[];
    }>(
      `SELECT source_state, source_revision, effective_state, capabilities
         FROM exomem_entitlements
        WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.deepEqual(entitlement.rows[0], {
      source_state: "active",
      source_revision: "evt_after_deletion_started",
      effective_state: "deleted",
      capabilities: [],
    });

    assert.deepEqual(
      await store.applyVerifiedEventAndMarkProcessedAtomically({
        eventId: `reconcile:${TENANT}:2026-07-13T06:40:00Z`,
        eventType: "subscription.reconciled",
        environment: "sandbox",
        origin: "reconciliation",
        revision: {
          occurredAt: "2026-07-13T06:40:00Z",
          eventId: `reconcile:${TENANT}:2026-07-13T06:40:00Z`,
        },
        correlation: {
          productKey: "exomem-hosted",
          userId: USER,
          tenantId: TENANT,
        },
        sourceState: "past_due",
        capabilities: ["capture", "recall", "export"],
        resourceLimits: {
          storageBytes: 5 * 1024 * 1024 * 1024,
          uploadBytes: 100 * 1024 * 1024,
          workerCount: 0,
        },
        providerReferences: {
          customerId: "ctm_reconciliation_must_not_project",
          subscriptionId: "sub_deletion_pending",
          transactionId: null,
          productId: "pro_reconciliation_must_not_project",
          priceId: null,
        },
        subscriptionCarriesFriendPrice: false,
        subscriptionFacts: {
          priceName: null,
          nextBilledAt: null,
          discountId: null,
          scheduledChangeAt: null,
        },
      }),
      { outcome: "ignored" }
    );

    const afterReconciliation = await pool.query<{
      source_state: string;
      source_revision: string | null;
      effective_state: string;
      capabilities: string[];
      provider_customer_ref: string | null;
    }>(
      `SELECT source_state, source_revision, effective_state, capabilities,
              provider_customer_ref
         FROM exomem_entitlements
        WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.deepEqual(afterReconciliation.rows[0], {
      source_state: "active",
      source_revision: "evt_after_deletion_started",
      effective_state: "deleted",
      capabilities: [],
      provider_customer_ref: "ctm_after_deletion_started",
    });
    const ignoredReceipt = await pool.query<{ disposition: string; error_code: string | null }>(
      `SELECT disposition, error_code
         FROM exomem_paddle_events
        WHERE paddle_event_id = $1`,
      [`reconcile:${TENANT}:2026-07-13T06:40:00Z`]
    );
    assert.deepEqual(ignoredReceipt.rows[0], {
      disposition: "ignored",
      error_code: null,
    });
  });

  it("leases each due Paddle subscription once and excludes future or deleting tenants", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state,
         capabilities, resource_limits, provider_environment, provider_subscription_ref
       ) VALUES ($1, 'paddle', 'active', 'active', '[]', '{}', 'sandbox', $2)`,
      [TENANT, "sub_reconciliation_lease"]
    );
    const sql: ExomemPaddleSql = async (strings, ...values) => {
      const text = strings.reduce(
        (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
        ""
      );
      const result = await pool.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
    const firstOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const claims = await Promise.all([
      claimPaddleReconciliationTargets(
        { limit: 1, leaseOwner: firstOwner, leaseMs: 30_000, environment: "sandbox" },
        sql
      ),
      claimPaddleReconciliationTargets(
        { limit: 1, leaseOwner: secondOwner, leaseMs: 30_000, environment: "sandbox" },
        sql
      ),
    ]);
    assert.equal(claims.flat().length, 1);
    const winningIndex = claims.findIndex((claim) => claim.length === 1);
    assert.notEqual(winningIndex, -1);
    const winner = winningIndex === 0 ? firstOwner : secondOwner;
    const winningTarget = claims[winningIndex]?.[0];
    assert.ok(winningTarget);
    assert.equal(
      await releasePaddleReconciliationLease({ target: winningTarget, leaseOwner: winner }, sql),
      true
    );

    await pool.query(
      `UPDATE exomem_entitlements
          SET provider_reconcile_after = now() + interval '1 hour'
        WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.deepEqual(
      await claimPaddleReconciliationTargets(
        { limit: 1, leaseOwner: firstOwner, leaseMs: 30_000, environment: "sandbox" },
        sql
      ),
      []
    );

    await pool.query(
      `UPDATE exomem_entitlements SET provider_reconcile_after = now() WHERE tenant_id = $1`,
      [TENANT]
    );
    await pool.query(
      `UPDATE exomem_tenants
          SET status = 'deletion_pending', desired_state = 'deleted'
        WHERE id = $1`,
      [TENANT]
    );
    assert.deepEqual(
      await claimPaddleReconciliationTargets(
        { limit: 1, leaseOwner: firstOwner, leaseMs: 30_000, environment: "sandbox" },
        sql
      ),
      []
    );
  });

  it("creates token plus encrypted outbox atomically and leases it once", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    const tokenDigest = Buffer.alloc(32, 0x51);
    const created = await createMagicAccessToken({
      emailNormalized: "owner@example.com",
      tokenDigest,
      browserChallengeDigest: Buffer.alloc(32, 0x52),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      deliverySecretCiphertext: {
        version: 1,
        algorithm: "A256GCM",
        iv: "opaque-iv",
        ciphertext: "opaque-ciphertext",
        tag: "opaque-tag",
      },
    });
    assert.ok(created);
    const queued = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM exomem_access_delivery_outbox"
    );
    assert.equal(queued.rows[0]?.count, "1");
    assert.equal(
      await claimMagicLinkDelivery({ leaseOwner: randomUUID(), deliveryId: randomUUID() }),
      null,
      "a targeted claim must never fall back to an unrelated eligible row"
    );

    const claims = await Promise.all([
      claimMagicLinkDelivery({
        leaseOwner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        deliveryId: created.deliveryId,
      }),
      claimMagicLinkDelivery({ leaseOwner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    assert.ok(claim);
    assert.equal(claim.deliveryId, created.deliveryId);

    assert.equal(
      await releaseMagicLinkDelivery({
        deliveryId: claim.deliveryId,
        leaseOwner:
          claims[0] === claim
            ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
        terminal: false,
      }),
      "retry"
    );
    await pool.query(
      "UPDATE exomem_access_delivery_outbox SET next_attempt_at = now() WHERE id = $1",
      [claim.deliveryId]
    );
    const retried = await claimMagicLinkDelivery({
      leaseOwner: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    assert.ok(retried);
    assert.equal(
      await markMagicLinkDeliverySent({
        deliveryId: retried.deliveryId,
        leaseOwner: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
      true
    );
    const state = await pool.query<{ state: string; secret_ciphertext: unknown }>(
      "SELECT state, secret_ciphertext FROM exomem_access_delivery_outbox WHERE id = $1",
      [retried.deliveryId]
    );
    assert.deepEqual(state.rows[0], { state: "sent", secret_ciphertext: null });

    assert.equal(
      await redeemMagicAccessTokenAtomic({
        tokenDigest,
        browserChallengeDigest: Buffer.alloc(32, 0x53),
        sessionDigest: Buffer.alloc(32, 0x54),
        csrfDigest: Buffer.alloc(32, 0x55),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
    const redeemed = await redeemMagicAccessTokenAtomic({
      tokenDigest,
      browserChallengeDigest: Buffer.alloc(32, 0x52),
      sessionDigest: Buffer.alloc(32, 0x56),
      csrfDigest: Buffer.alloc(32, 0x57),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.ok(redeemed);
    assert.equal(
      await redeemMagicAccessTokenAtomic({
        tokenDigest,
        browserChallengeDigest: Buffer.alloc(32, 0x52),
        sessionDigest: Buffer.alloc(32, 0x58),
        csrfDigest: Buffer.alloc(32, 0x59),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
  });

  it("checks the authoritative email before consumption and admits only one completing browser", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    const tokenDigest = randomBytes(32);
    const challenge = randomBytes(32);
    await pool.query(
      `INSERT INTO exomem_access_tokens
       (purpose, token_digest, browser_challenge_digest, magic_link_generation, user_id, tenant_id, expires_at, delivery_state)
       VALUES ('magic_link', $1, $2, 0, $3, $4, now() + interval '15 minutes', 'sent')`,
      [tokenDigest, challenge, USER, TENANT]
    );
    const attempt = (expectedEmailNormalized: string, browserChallengeDigest: Buffer | null) =>
      redeemMagicAccessTokenAtomic({
        tokenDigest,
        expectedEmailNormalized,
        browserChallengeDigest,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      });
    // A matching cookie cannot override an explicitly supplied wrong account.
    assert.equal(await attempt("other@example.com", challenge), null);
    assert.equal(await attempt("other@example.com", null), null);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM exomem_sessions")).rows[0].count,
      0
    );
    assert.equal(
      (await pool.query("SELECT consumed_at FROM exomem_access_tokens")).rows[0].consumed_at,
      null
    );
    const results = await Promise.all([
      attempt("owner@example.com", null),
      attempt("owner@example.com", randomBytes(32)),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.find(Boolean)?.browserChallengeMatched, false);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM exomem_sessions")).rows[0].count,
      1
    );
    assert.ok(
      (await pool.query("SELECT consumed_at FROM exomem_access_tokens")).rows[0].consumed_at
    );
    assert.equal(await attempt("owner@example.com", null), null);
    const anotherDigest = randomBytes(32);
    await pool.query(
      `INSERT INTO exomem_access_tokens
       (purpose, token_digest, browser_challenge_digest, magic_link_generation, user_id, tenant_id, expires_at, delivery_state)
       SELECT purpose, $1, browser_challenge_digest, magic_link_generation, user_id, tenant_id, expires_at, delivery_state
       FROM exomem_access_tokens WHERE token_digest = $2`,
      [anotherDigest, tokenDigest]
    );
    const mismatched = await redeemMagicAccessTokenAtomic({
      tokenDigest: anotherDigest,
      expectedEmailNormalized: "owner@example.com",
      browserChallengeDigest: randomBytes(32),
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(mismatched?.tenantId, TENANT);
    assert.equal(mismatched?.browserChallengeMatched, false);
  });

  for (const unavailable of ["expired", "revoked", "generation", "tenant", "pending"] as const) {
    it(`email confirmation cannot redeem a link with ${unavailable} authority`, async () => {
      await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
        USER,
        "owner@example.com",
      ]);
      await pool.query(
        `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
         VALUES ($1, $2, 'active', 'running')`,
        [TENANT, USER]
      );
      const tokenDigest = randomBytes(32);
      await pool.query(
        `INSERT INTO exomem_access_tokens
         (purpose, token_digest, browser_challenge_digest, magic_link_generation, user_id, tenant_id, created_at, expires_at, delivery_state)
         VALUES ('magic_link', $1, $2, 0, $3, $4, now() - interval '16 minutes', now() + interval '15 minutes', 'sent')`,
        [tokenDigest, randomBytes(32), USER, TENANT]
      );
      if (unavailable === "expired")
        await pool.query(
          "UPDATE exomem_access_tokens SET expires_at = now() - interval '1 minute'"
        );
      if (unavailable === "revoked")
        await pool.query("UPDATE exomem_access_tokens SET revoked_at = now()");
      if (unavailable === "generation")
        await pool.query("UPDATE exomem_tenants SET magic_link_generation = 1");
      if (unavailable === "tenant") {
        const other = randomUUID();
        await pool.query("INSERT INTO users (id, email) VALUES ($1, 'another@example.com')", [
          other,
        ]);
        await pool.query("UPDATE exomem_tenants SET owner_user_id = $1", [other]);
      }
      if (unavailable === "pending")
        await pool.query("UPDATE exomem_access_tokens SET delivery_state = 'pending'");
      assert.equal(
        await redeemMagicAccessTokenAtomic({
          tokenDigest,
          browserChallengeDigest: null,
          expectedEmailNormalized: "owner@example.com",
          sessionDigest: randomBytes(32),
          csrfDigest: randomBytes(32),
          sessionExpiresAt: new Date(Date.now() + 60_000),
        }),
        null
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int AS count FROM exomem_sessions")).rows[0].count,
        0
      );
      assert.equal(
        (await pool.query("SELECT consumed_at FROM exomem_access_tokens")).rows[0].consumed_at,
        null
      );
    });
  }

  it("invalidates an older unconsumed magic link when a newer request is queued", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    const secret = {
      version: 1 as const,
      algorithm: "A256GCM" as const,
      iv: "opaque-iv",
      ciphertext: "opaque-ciphertext",
      tag: "opaque-tag",
    };
    const first = await createMagicAccessToken({
      emailNormalized: "owner@example.com",
      tokenDigest: Buffer.alloc(32, 0x61),
      browserChallengeDigest: Buffer.alloc(32, 0x62),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      deliverySecretCiphertext: secret,
    });
    const second = await createMagicAccessToken({
      emailNormalized: "owner@example.com",
      tokenDigest: Buffer.alloc(32, 0x63),
      browserChallengeDigest: Buffer.alloc(32, 0x64),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      deliverySecretCiphertext: secret,
    });
    assert.ok(first);
    assert.ok(second);
    const tokens = await pool.query<{
      id: string;
      revoked_at: Date | null;
      delivery_state: string;
    }>(
      `SELECT id, revoked_at, delivery_state
       FROM exomem_access_tokens
       ORDER BY created_at, id`
    );
    assert.equal(tokens.rows.find((row) => row.id === first.tokenId)?.delivery_state, "failed");
    assert.ok(tokens.rows.find((row) => row.id === first.tokenId)?.revoked_at);
    assert.equal(tokens.rows.find((row) => row.id === second.tokenId)?.revoked_at, null);
    const firstOutbox = await pool.query<{ state: string; secret_ciphertext: unknown }>(
      "SELECT state, secret_ciphertext FROM exomem_access_delivery_outbox WHERE token_id = $1",
      [first.tokenId]
    );
    assert.deepEqual(firstOutbox.rows[0], { state: "failed", secret_ciphertext: null });
  });

  it("admits only the newest generation when magic-link requests race", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    const secret = {
      version: 1 as const,
      algorithm: "A256GCM" as const,
      iv: "opaque-iv",
      ciphertext: "opaque-ciphertext",
      tag: "opaque-tag",
    };
    const candidates = [
      {
        tokenDigest: Buffer.alloc(32, 0x65),
        browserChallengeDigest: Buffer.alloc(32, 0x66),
      },
      {
        tokenDigest: Buffer.alloc(32, 0x67),
        browserChallengeDigest: Buffer.alloc(32, 0x68),
      },
    ];

    const created = await Promise.all(
      candidates.map((candidate) =>
        createMagicAccessToken({
          emailNormalized: "owner@example.com",
          ...candidate,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          deliverySecretCiphertext: secret,
        })
      )
    );
    assert.equal(created.filter(Boolean).length, 2);

    const firstClaim = await claimMagicLinkDelivery({
      leaseOwner: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });
    assert.ok(firstClaim);
    const secondClaim = await claimMagicLinkDelivery({
      leaseOwner: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    });
    assert.equal(secondClaim, null);

    assert.equal(
      await markMagicLinkDeliverySent({
        deliveryId: firstClaim.deliveryId,
        leaseOwner: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
      true
    );
    const generations = await pool.query<{
      token_digest: Buffer;
      magic_link_generation: string;
      tenant_generation: string;
    }>(
      `SELECT token.token_digest,
              token.magic_link_generation::text,
              tenant.magic_link_generation::text AS tenant_generation
       FROM exomem_access_tokens AS token
       JOIN exomem_tenants AS tenant ON tenant.id = token.tenant_id
       WHERE token.purpose = 'magic_link'
       ORDER BY token.magic_link_generation`
    );
    assert.equal(generations.rows.length, 2);
    const winner = generations.rows.find(
      (row) => row.magic_link_generation === row.tenant_generation
    );
    const loser = generations.rows.find(
      (row) => row.magic_link_generation !== row.tenant_generation
    );
    assert.ok(winner);
    assert.ok(loser);
    assert.deepEqual(firstClaim.tokenDigest, winner.token_digest);

    // Delivery state is not the authority: even a stale row marked sent must
    // fail the generation fence at redemption.
    await pool.query(
      "UPDATE exomem_access_tokens SET delivery_state = 'sent', delivered_at = now()"
    );
    const loserCandidate = candidates.find((candidate) =>
      candidate.tokenDigest.equals(loser.token_digest)
    );
    const winnerCandidate = candidates.find((candidate) =>
      candidate.tokenDigest.equals(winner.token_digest)
    );
    assert.ok(loserCandidate);
    assert.ok(winnerCandidate);
    assert.equal(
      await redeemMagicAccessTokenAtomic({
        ...loserCandidate,
        sessionDigest: Buffer.alloc(32, 0x69),
        csrfDigest: Buffer.alloc(32, 0x6a),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
    assert.ok(
      await redeemMagicAccessTokenAtomic({
        ...winnerCandidate,
        sessionDigest: Buffer.alloc(32, 0x6b),
        csrfDigest: Buffer.alloc(32, 0x6c),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      })
    );
  });

  it("fences and gates a confirmed deletion on the tenant row before any cell is bound", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    const digest = Buffer.alloc(32, 0x71);
    assert.ok(
      await createDeletionConfirmationToken({
        userId: USER,
        tenantId: TENANT,
        tokenDigest: digest,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })
    );
    const consumed = await consumeDeletionConfirmationAtomic({
      userId: USER,
      tenantId: TENANT,
      tokenDigest: digest,
    });
    assert.equal(consumed, true);
    const tenant = await pool.query<{
      status: string;
      desired_state: string;
      fence_generation: string;
    }>("SELECT status, desired_state, fence_generation::text FROM exomem_tenants WHERE id = $1", [
      TENANT,
    ]);
    assert.deepEqual(tenant.rows[0], {
      status: "deletion_pending",
      desired_state: "deleted",
      fence_generation: "2",
    });
  });
});
