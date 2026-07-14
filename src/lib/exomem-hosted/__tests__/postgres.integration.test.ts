import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";
import {
  __setExomemSqlForTests,
  claimMagicLinkDelivery,
  clearExomemCheckoutTransaction,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  createMagicAccessToken,
  createTransferGrantRecord,
  markMagicLinkDeliverySent,
  pruneStaleRateLimitBuckets,
  recordExomemCheckoutTransaction,
  redeemMagicAccessTokenAtomic,
  releaseMagicLinkDelivery,
  takeRateLimit,
  type ExomemSql,
} from "../db";
import { SqlLifecycleStore } from "../lifecycle-store";
import { getOwnerExport, listOwnerExports } from "../durability";
import { SqlExportGcStore } from "../export-gc";
import { createSqlExomemPaddleEventStore, type ExomemPaddleSql } from "../paddle-event-store";
import {
  claimPaddleReconciliationTargets,
  releasePaddleReconciliationLease,
} from "../paddle-reconciliation-runtime";
import { FakeCellProvisioner } from "../provisioner";
import { LifecycleReconciler, expectedCellConfiguration } from "../reconciler";
import { SensitiveSecret, digestSecret, encryptSecret } from "../security";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const CELL = "33333333-3333-4333-8333-333333333333";

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

describe("real PostgreSQL hosted contracts", { skip: !DATABASE_URL }, () => {
  let pool: Pool;

  before(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
    const adapter: ExomemSql = async (strings, ...values) => {
      const text = strings.reduce(
        (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
        ""
      );
      const result = await pool.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
    __setExomemSqlForTests(adapter);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE users CASCADE");
    await pool.query("TRUNCATE TABLE rate_limit_events");
    await pool.query("TRUNCATE TABLE exomem_rate_limit_buckets");
  });

  after(async () => {
    __setExomemSqlForTests(null);
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

  it("atomically prunes expired tenant transfer rows while issuing a new ticket", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version, provider_ref,
         service_credential_ciphertext, service_credential_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', 'test', 'provider-ref', $3, $4)`,
      [CELL, TENANT, JSON.stringify({ encrypted: true }), Buffer.alloc(32, 0x21)]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_transfer_grants (
         grant_digest, tenant_id, cell_id, user_id, principal_scope_digest,
         operation, audience, issued_at, expires_at, byte_limit
       ) VALUES ($1, $2, $3, $4, $5, 'download', 'exomem-hosted-transfer',
                 now() - interval '10 minutes', now() - interval '5 minutes', 1024)`,
      [Buffer.alloc(32, 0x11), TENANT, CELL, USER, Buffer.alloc(32, 0x12)]
    );

    assert.ok(
      await createTransferGrantRecord({
        grantDigest: Buffer.alloc(32, 0x13),
        tenantId: TENANT,
        cellId: CELL,
        userId: USER,
        principalScopeDigest: Buffer.alloc(32, 0x14),
        operation: "upload",
        issuedAt: new Date(Date.now()),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        byteLimit: 2048,
      })
    );
    const rows = await pool.query<{ operation: string }>(
      "SELECT operation FROM exomem_transfer_grants WHERE tenant_id = $1",
      [TENANT]
    );
    assert.deepEqual(rows.rows, [{ operation: "upload" }]);
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
       VALUES ($1, $2, 'active', 'running')`,
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
    const application = {
      eventId: "evt_atomic_fresh",
      eventType: "subscription.created",
      environment: "sandbox" as const,
      origin: "webhook" as const,
      revision: {
        occurredAt: "2026-07-13T06:13:03.661Z",
        eventId: "evt_atomic_fresh",
      },
      correlation: {
        productKey: "exomem-hosted" as const,
        userId: USER,
        tenantId: TENANT,
      },
      sourceState: "active" as const,
      capabilities: ["capture", "recall", "export"] as const,
      resourceLimits: {
        storageBytes: 5 * 1024 * 1024 * 1024,
        uploadBytes: 100 * 1024 * 1024,
        workerCount: 0,
      },
      providerReferences: {
        customerId: "ctm_atomic_fresh",
        subscriptionId: "sub_atomic_fresh",
        transactionId: "txn_atomic_fresh",
        productId: "pro_atomic_fresh",
        priceId: "pri_atomic_fresh",
      },
    };

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
      effective_state: "active",
      provider_subscription_ref: "sub_atomic_fresh",
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

  it("atomically couples exact billing proof to the leased deletion checkpoint", async () => {
    const operationId = "44444444-4444-4444-8444-444444444401";
    const transactionId = `txn_${"m".repeat(26)}`;
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, fence_generation)
       VALUES ($1, $2, 'deletion_pending', 'deleted', 3)`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (
         tenant_id, source, source_state, effective_state, capabilities, resource_limits,
         source_revision, provider_environment, provider_transaction_ref
       ) VALUES (
         $1, 'paddle', 'checkout_pending', 'deleted', '[]', '{}',
         'before-provider-race', 'sandbox', $2
       )`,
      [TENANT, transactionId]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, operation_type, state, idempotency_key, fence_generation,
         checkpoint, attempts, lease_owner, lease_expires_at
       ) VALUES (
         $1, $2, 'delete', 'running', 'atomic-billing-proof', 3,
         'quiesced', 2, 'billing-worker', now() + interval '1 minute'
       )`,
      [operationId, TENANT]
    );

    const exactTarget = {
      tenantId: TENANT,
      userId: USER,
      source: "paddle" as const,
      sourceState: "checkout_pending",
      sourceRevision: "before-provider-race",
      providerEnvironment: "sandbox" as const,
      customerRef: null,
      subscriptionRef: null,
      transactionRef: transactionId,
    };
    const store = new SqlLifecycleStore();
    const providerUpdate = await pool.connect();
    const promotedSubscription = `sub_${"n".repeat(26)}`;
    try {
      await providerUpdate.query("BEGIN");
      await providerUpdate.query(
        `UPDATE exomem_entitlements
            SET source_revision = 'after-provider-race', provider_subscription_ref = $1
          WHERE tenant_id = $2`,
        [promotedSubscription, TENANT]
      );
      const staleAdvance = store.advanceBillingTerminated({
        operationId,
        owner: "billing-worker",
        proof: exactTarget,
      });
      await waitForBlockedQuery(pool, "exomem:lifecycle-advance-billing-terminated");
      await providerUpdate.query("COMMIT");
      assert.equal(await staleAdvance, false);
    } finally {
      await providerUpdate.query("ROLLBACK").catch(() => undefined);
      providerUpdate.release();
    }
    assert.deepEqual(
      (
        await pool.query(
          `SELECT source_state, source_revision, provider_subscription_ref
             FROM exomem_entitlements WHERE tenant_id = $1`,
          [TENANT]
        )
      ).rows[0],
      {
        source_state: "checkout_pending",
        source_revision: "after-provider-race",
        provider_subscription_ref: promotedSubscription,
      }
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT state, checkpoint FROM exomem_lifecycle_operations WHERE id = $1`,
          [operationId]
        )
      ).rows[0],
      { state: "running", checkpoint: "quiesced" }
    );

    await pool.query(
      `UPDATE exomem_entitlements
          SET source_revision = 'before-provider-race', provider_subscription_ref = NULL
        WHERE tenant_id = $1`,
      [TENANT]
    );
    assert.equal(
      await store.advanceBillingTerminated({
        operationId,
        owner: "billing-worker",
        proof: exactTarget,
      }),
      true
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT source_state, provider_environment, provider_customer_ref,
                  provider_subscription_ref, provider_transaction_ref
             FROM exomem_entitlements WHERE tenant_id = $1`,
          [TENANT]
        )
      ).rows[0],
      {
        source_state: "deletion_cancelled",
        provider_environment: null,
        provider_customer_ref: null,
        provider_subscription_ref: null,
        provider_transaction_ref: null,
      }
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT state, checkpoint, attempts, lease_owner, lease_expires_at
             FROM exomem_lifecycle_operations WHERE id = $1`,
          [operationId]
        )
      ).rows[0],
      {
        state: "waiting",
        checkpoint: "billing-quiesced",
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
      }
    );

    const eventSql: ExomemPaddleSql = async (strings, ...values) => {
      const text = strings.reduce(
        (query, part, index) => query + part + (index < values.length ? `$${index + 1}` : ""),
        ""
      );
      const result = await pool.query(text, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
    const eventStore = createSqlExomemPaddleEventStore(eventSql);
    assert.deepEqual(
      await eventStore.applyVerifiedEventAndMarkProcessedAtomically({
        eventId: "evt_after_billing_gate",
        eventType: "transaction.completed",
        environment: "sandbox",
        origin: "webhook",
        revision: {
          occurredAt: "2026-07-13T08:45:00Z",
          eventId: "evt_after_billing_gate",
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
          customerId: null,
          subscriptionId: null,
          transactionId,
          productId: "pro_after_billing_gate",
          priceId: "pri_after_billing_gate",
        },
      }),
      { outcome: "ignored" }
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT source_state, provider_environment, provider_transaction_ref
             FROM exomem_entitlements WHERE tenant_id = $1`,
          [TENANT]
        )
      ).rows[0],
      {
        source_state: "deletion_cancelled",
        provider_environment: null,
        provider_transaction_ref: null,
      }
    );
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

    const claims = await Promise.all([
      claimMagicLinkDelivery({ leaseOwner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      claimMagicLinkDelivery({ leaseOwner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    assert.ok(claim);

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

  it("deletes a consumed invite and scrubs restore secrets after destruction", async () => {
    const session = "44444444-4444-4444-8444-444444444444";
    const restore = "55555555-5555-4555-8555-555555555555";
    const deletion = "66666666-6666-4666-8666-666666666666";
    const exportOperation = "77777777-7777-4777-8777-777777777777";
    const exportId = "88888888-8888-4888-8888-888888888888";
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version, provider_ref,
         private_endpoint_ciphertext, service_credential_ciphertext,
         service_credential_digest
       ) VALUES (
         $1, $2, 'active', 'bound', 'running', '1', 'test', 'provider-private',
         '{"encrypted":true}', '{"encrypted":true}', $3
       )`,
      [CELL, TENANT, Buffer.alloc(32, 0x31)]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_sessions (
         id, user_id, tenant_id, session_digest, csrf_digest, expires_at
       ) VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
      [session, USER, TENANT, Buffer.alloc(32, 0x41), Buffer.alloc(32, 0x42)]
    );
    await pool.query(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source,
         created_by_principal_digest, expires_at, consumed_at,
         consumed_by_user_id, redeemed_tenant_id, redeemed_session_id
       ) VALUES ($1, $2, 'complimentary', $3, now() + interval '1 day', now(), $4, $5, $6)`,
      [Buffer.alloc(32, 0x43), "owner@example.com", Buffer.alloc(32, 0x44), USER, TENANT, session]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, idempotency_key,
         fence_generation,
         input_reference_ciphertext, input_reference_digest, input_source_cell_id,
         input_archive_sha256, input_manifest_sha256, input_archive_size
       ) VALUES (
         $1, $2, $3, 'restore', 'succeeded', 'restore-test', 1,
         '{"encrypted":true}', $4, $3, $5, $6, 1024
       )`,
      [restore, TENANT, CELL, Buffer.alloc(32, 0x45), "a".repeat(64), "b".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, checkpoint,
         idempotency_key, fence_generation, completed_at
       ) VALUES ($1, $2, $3, 'export', 'succeeded', 'readiness-proved',
                 'export-before-delete', 1, now())`,
      [exportOperation, TENANT, CELL]
    );
    await pool.query(
      `INSERT INTO exomem_exports (
         id, tenant_id, cell_id, operation_id,
         storage_reference_ciphertext, storage_reference_digest,
         archive_sha256, manifest_sha256, archive_size,
         encryption_scheme, integrity_verified, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1024,
                 'envelope-aes-256-gcm', true, now() + interval '1 hour')`,
      [
        exportId,
        TENANT,
        CELL,
        exportOperation,
        JSON.stringify({ encrypted: true }),
        Buffer.alloc(32, 0x46),
        "c".repeat(64),
        "d".repeat(64),
      ]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, checkpoint,
         idempotency_key, fence_generation, lease_owner, lease_expires_at
       ) VALUES (
         $1, $2, $3, 'delete', 'running', 'destroyed',
         'delete-test', 1, 'worker-delete', now() + interval '1 minute'
       )`,
      [deletion, TENANT, CELL]
    );

    const store = new SqlLifecycleStore();
    assert.equal(await store.markCellState(deletion, "worker-delete", "deleted"), true);

    const counts = await pool.query<{ sessions: string; invites: string }>(
      `SELECT
         (SELECT count(*)::text FROM exomem_sessions) AS sessions,
         (SELECT count(*)::text FROM exomem_invites) AS invites`
    );
    assert.deepEqual(counts.rows[0], { sessions: "0", invites: "0" });
    const scrubbed = await pool.query<{
      input_reference_ciphertext: unknown;
      input_reference_digest: Buffer | null;
      input_source_cell_id: string | null;
      input_destroyed_at: Date | null;
    }>(
      `SELECT input_reference_ciphertext, input_reference_digest,
              input_source_cell_id, input_destroyed_at
       FROM exomem_lifecycle_operations WHERE id = $1`,
      [restore]
    );
    assert.deepEqual(
      {
        ciphertext: scrubbed.rows[0]?.input_reference_ciphertext,
        digest: scrubbed.rows[0]?.input_reference_digest,
        source: scrubbed.rows[0]?.input_source_cell_id,
        destroyed: scrubbed.rows[0]?.input_destroyed_at instanceof Date,
      },
      { ciphertext: null, digest: null, source: null, destroyed: true }
    );
    const cell = await pool.query<{
      provider_ref: string | null;
      service_credential_ciphertext: unknown;
      service_credential_digest: Buffer | null;
    }>(
      `SELECT provider_ref, service_credential_ciphertext, service_credential_digest
       FROM exomem_cells WHERE id = $1`,
      [CELL]
    );
    assert.deepEqual(cell.rows[0], {
      provider_ref: null,
      service_credential_ciphertext: null,
      service_credential_digest: null,
    });
    const deletedExport = await pool.query<{
      state: string;
      storage_reference_digest: Buffer | null;
      archive_sha256: string | null;
      provider_deleted_at: Date | null;
    }>(
      `SELECT state, storage_reference_digest, archive_sha256, provider_deleted_at
       FROM exomem_exports WHERE id = $1`,
      [exportId]
    );
    assert.deepEqual(
      {
        state: deletedExport.rows[0]?.state,
        digest: deletedExport.rows[0]?.storage_reference_digest,
        archive: deletedExport.rows[0]?.archive_sha256,
        providerDeleted: deletedExport.rows[0]?.provider_deleted_at instanceof Date,
      },
      { state: "deleted", digest: null, archive: null, providerDeleted: true }
    );
  });

  it("fences and gates confirmed deletion even before any cell is bound", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'provisioning', 'running')`,
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
    assert.ok(consumed);
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

    const store = new SqlLifecycleStore();
    const operation = await store.claim({
      owner: "delete-worker",
      leaseMs: 30_000,
      maxAttempts: 6,
      tenantId: TENANT,
    });
    assert.equal(operation?.operationType, "delete");
    assert.equal(operation?.cellId, null);
    assert.equal(operation?.fenceGeneration, 2);
    assert.equal(await store.applyLocalGate(operation!.id, "delete-worker", "deleted"), true);
  });

  it("runs lifecycle advance and persists a non-attempt-consuming provider wait", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'provisioning', 'running')`,
      [TENANT, USER]
    );
    const store = new SqlLifecycleStore();
    await assert.rejects(store.enqueue(TENANT, "delete", "unsafe-direct-delete"));

    const queued = await store.enqueue(TENANT, "provision", "normal-provision");
    const claimed = await store.claim({
      owner: "normal-worker",
      leaseMs: 30_000,
      maxAttempts: 6,
      tenantId: TENANT,
    });
    assert.equal(claimed?.id, queued.id);
    assert.equal(claimed?.checkpoint, "created");
    assert.equal(
      await store.advance(queued.id, "normal-worker", "created", "candidate-created"),
      true
    );
    const row = await pool.query<{ state: string; checkpoint: string }>(
      "SELECT state, checkpoint FROM exomem_lifecycle_operations WHERE id = $1",
      [queued.id]
    );
    assert.deepEqual(row.rows[0], { state: "waiting", checkpoint: "candidate-created" });

    const providerClaim = await new SqlLifecycleStore().claim({
      owner: "provider-worker",
      leaseMs: 30_000,
      maxAttempts: 6,
      tenantId: TENANT,
    });
    assert.equal(providerClaim?.attempts, 1);
    const retryAt = new Date(Date.now() + 30_000);
    assert.equal(
      await store.waitForProvider(queued.id, "provider-worker", "candidate-created", retryAt),
      true
    );
    const waiting = await pool.query<{
      state: string;
      attempts: number;
      error_code: string | null;
    }>("SELECT state, attempts, error_code FROM exomem_lifecycle_operations WHERE id = $1", [
      queued.id,
    ]);
    assert.deepEqual(waiting.rows[0], { state: "waiting", attempts: 0, error_code: null });
    assert.equal(
      await new SqlLifecycleStore().claim({
        owner: "restart-worker",
        leaseMs: 30_000,
        maxAttempts: 6,
        tenantId: TENANT,
      }),
      null
    );
  });

  it("round-trips database-created export expiry through begin and record", async () => {
    const envelopeKey = Buffer.alloc(32, 0x22);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, fence_generation)
       VALUES ($1, $2, 'active', 'running', 4)`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version
       ) VALUES ($1, $2, 'draining', 'bound', 'quiesced', '1', 'test')`,
      [CELL, TENANT]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);

    const store = new SqlLifecycleStore();
    const queued = await store.enqueue(TENANT, "export", "database-expiry-round-trip", CELL, {
      exportTtlMs: 86_400_000,
    });
    await pool.query(
      `UPDATE exomem_lifecycle_operations
          SET checkpoint = 'quiesced', state = 'waiting', next_attempt_at = now()
        WHERE id = $1`,
      [queued.id]
    );
    const claimed = await store.claim({
      owner: "export-worker",
      leaseMs: 30_000,
      maxAttempts: 6,
      tenantId: TENANT,
    });
    assert.ok(claimed?.exportExpiresAt);
    assert.equal(
      await store.beginExport(claimed.id, "export-worker", claimed.exportExpiresAt),
      true
    );
    assert.equal(
      await store.recordExportResult({
        operationId: claimed.id,
        owner: "export-worker",
        tenantId: TENANT,
        cellId: CELL,
        storageReferenceEnvelope: encryptSecret("provider-export-ref", {
          key: envelopeKey,
          randomBytes: (size) => Buffer.alloc(size, 0x23),
        }),
        storageReferenceDigest: digestSecret("provider-export-ref"),
        releaseReferenceEnvelope: encryptSecret("cell-release-ref", {
          key: envelopeKey,
          randomBytes: (size) => Buffer.alloc(size, 0x24),
        }),
        releaseReferenceDigest: digestSecret("cell-release-ref"),
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        archiveSize: 1024,
        encryptionScheme: "envelope-aes-256-gcm",
        integrityVerified: true,
        expiresAt: claimed.exportExpiresAt,
      }),
      "available"
    );
  });

  it("persists expired export release as mandatory recovery and completes it atomically", async () => {
    const operationId = "44444444-4444-4444-8444-444444444480";
    const envelopeKey = Buffer.alloc(32, 0x32);
    const credential = "postgres-expired-export-credential";
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, fence_generation)
       VALUES ($1, $2, 'suspended', 'suspended', 4)`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version, provider_ref,
         service_credential_ciphertext, service_credential_digest
       ) VALUES ($1, $2, 'draining', 'bound', 'quiesced', '1', 'test',
                 $3, $4, $5)`,
      [
        CELL,
        TENANT,
        `provider-${CELL}`,
        JSON.stringify(
          encryptSecret(credential, {
            key: envelopeKey,
            randomBytes: (size) => Buffer.alloc(size, 0x31),
          })
        ),
        digestSecret(credential),
      ]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, idempotency_key,
         fence_generation, checkpoint, attempts, lease_owner, lease_expires_at
       ) VALUES ($1, $2, $3, 'export', 'running', 'expired-export-recovery',
                 4, 'quiesced', 9, 'export-worker', now() + interval '1 minute')`,
      [operationId, TENANT, CELL]
    );

    const store = new SqlLifecycleStore();
    const expiresAt = new Date(Date.now() - 1_000);
    assert.equal(await store.beginExport(operationId, "export-worker", expiresAt), true);
    assert.equal(
      await store.recordExportResult({
        operationId,
        owner: "export-worker",
        tenantId: TENANT,
        cellId: CELL,
        storageReferenceEnvelope: encryptSecret("provider-export-ref", {
          key: envelopeKey,
          randomBytes: (size) => Buffer.alloc(size, 0x33),
        }),
        storageReferenceDigest: digestSecret("provider-export-ref"),
        releaseReferenceEnvelope: encryptSecret("cell-release-ref", {
          key: envelopeKey,
          randomBytes: (size) => Buffer.alloc(size, 0x34),
        }),
        releaseReferenceDigest: digestSecret("cell-release-ref"),
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        archiveSize: 1024,
        encryptionScheme: "envelope-aes-256-gcm",
        integrityVerified: true,
        expiresAt,
      }),
      "expired"
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT operation.checkpoint, export_row.state AS export_state
             FROM exomem_lifecycle_operations AS operation
             JOIN exomem_exports AS export_row ON export_row.operation_id = operation.id
            WHERE operation.id = $1`,
          [operationId]
        )
      ).rows[0],
      { checkpoint: "export-expired-release", export_state: "deleting" }
    );

    assert.equal(
      await store.retry(
        operationId,
        "export-worker",
        "EXPIRED_EXPORT_RELEASE_PENDING",
        new Date(Date.now() - 1)
      ),
      true
    );
    const recovery = await store.claim({
      owner: "recovery-worker",
      leaseMs: 30_000,
      maxAttempts: 6,
      tenantId: TENANT,
    });
    assert.equal(recovery?.id, operationId);
    assert.equal(recovery?.checkpoint, "export-expired-release");
    await store.retry(
      operationId,
      "recovery-worker",
      "EXPIRED_EXPORT_RELEASE_PENDING",
      new Date(Date.now() - 1)
    );
    const provisioner = new FakeCellProvisioner();
    await provisioner.provision({
      context: {
        operationId: "postgres-resource-seed",
        checkpoint: "seed",
        idempotencyKey: "postgres-resource-seed",
        fenceGeneration: 4,
      },
      tenantId: TENANT,
      cellId: CELL,
      protocolVersion: "1",
      releaseVersion: "test",
      serviceCredential: new SensitiveSecret(credential),
      workerPolicy: { workerCount: 0, semantic: false, media: false },
    });
    const reconciler = new LifecycleReconciler({
      store,
      provisioner,
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "test",
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      envelopeKey,
    });
    assert.deepEqual(await reconciler.reconcileOne({ owner: "release-worker", tenantId: TENANT }), {
      kind: "advanced",
      operationId,
      checkpoint: "export-expired-released",
    });
    assert.deepEqual(
      (
        await pool.query(
          `SELECT state, checkpoint,
                  export_release_reference_ciphertext IS NULL AS release_cleared,
                  lease_owner IS NULL AS lease_cleared
             FROM exomem_lifecycle_operations WHERE id = $1`,
          [operationId]
        )
      ).rows[0],
      {
        state: "waiting",
        checkpoint: "export-expired-released",
        release_cleared: true,
        lease_cleared: true,
      }
    );
    assert.deepEqual(await reconciler.reconcileOne({ owner: "resume-worker", tenantId: TENANT }), {
      kind: "advanced",
      operationId,
      checkpoint: "export-expired-resumed",
    });
    assert.deepEqual(
      await reconciler.reconcileOne({ owner: "readiness-worker", tenantId: TENANT }),
      { kind: "advanced", operationId, checkpoint: "export-expired-readiness-proved" }
    );
    assert.deepEqual(
      await reconciler.reconcileOne({ owner: "restoration-complete", tenantId: TENANT }),
      { kind: "terminal", operationId, code: "EXPORT_EXPIRED" }
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT state, error_code,
                  export_release_reference_ciphertext IS NULL AS release_cleared,
                  lease_owner IS NULL AS lease_cleared
             FROM exomem_lifecycle_operations WHERE id = $1`,
          [operationId]
        )
      ).rows[0],
      {
        state: "failed_terminal",
        error_code: "EXPORT_EXPIRED",
        release_cleared: true,
        lease_cleared: true,
      }
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT tenant.status, tenant.desired_state,
                  cell.lifecycle_state, cell.desired_state AS cell_desired_state,
                  cell.readiness_code
             FROM exomem_tenants AS tenant
             JOIN exomem_cells AS cell ON cell.id = tenant.bound_cell_id
            WHERE tenant.id = $1`,
          [TENANT]
        )
      ).rows[0],
      {
        status: "active",
        desired_state: "running",
        lifecycle_state: "active",
        cell_desired_state: "running",
        readiness_code: "CELL_READY",
      }
    );
  });

  it("filters expired owner artifacts and pins an unexpired restore against GC", async () => {
    const failed = "44444444-4444-4444-8444-444444444491";
    const availableOperation = "44444444-4444-4444-8444-444444444492";
    const expiredOperation = "44444444-4444-4444-8444-444444444493";
    const availableExport = "55555555-5555-4555-8555-555555555591";
    const expiredExport = "55555555-5555-4555-8555-555555555592";
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state, fence_generation)
       VALUES ($1, $2, 'active', 'running', 7)`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version, provider_ref,
         service_credential_ciphertext, service_credential_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', 'test', 'provider-ref', $3, $4)`,
      [CELL, TENANT, JSON.stringify({ encrypted: true }), Buffer.alloc(32, 0x21)]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations
         (id, tenant_id, cell_id, operation_type, state, idempotency_key,
          fence_generation, checkpoint, completed_at)
       VALUES
         ($1, $4, $5, 'export', 'failed_terminal', 'failed-export', 7, 'created', now()),
         ($2, $4, $5, 'export', 'succeeded', 'available-export', 7, 'readiness-proved', now()),
         ($3, $4, $5, 'export', 'succeeded', 'expired-export', 7, 'readiness-proved', now())`,
      [failed, availableOperation, expiredOperation, TENANT, CELL]
    );
    const availableRef = "provider-available-export";
    const expiredRef = "provider-expired-export";
    const key = Buffer.alloc(32, 0x31);
    await pool.query(
      `INSERT INTO exomem_exports (
         id, tenant_id, cell_id, operation_id, storage_reference_ciphertext,
         storage_reference_digest, archive_sha256, manifest_sha256, archive_size,
         encryption_scheme, integrity_verified, expires_at
       ) VALUES
         ($1, $3, $4, $5, $6, $7, $8, $9, 1024,
          'envelope-aes-256-gcm', true, now() + interval '1 hour'),
         ($2, $3, $4, $10, $11, $12, $13, $14, 2048,
          'envelope-aes-256-gcm', true, now() - interval '1 hour')`,
      [
        availableExport,
        expiredExport,
        TENANT,
        CELL,
        availableOperation,
        JSON.stringify(
          encryptSecret(availableRef, { key, randomBytes: (size) => Buffer.alloc(size, 0x32) })
        ),
        digestSecret(availableRef),
        "a".repeat(64),
        "b".repeat(64),
        expiredOperation,
        JSON.stringify(
          encryptSecret(expiredRef, { key, randomBytes: (size) => Buffer.alloc(size, 0x33) })
        ),
        digestSecret(expiredRef),
        "c".repeat(64),
        "d".repeat(64),
      ]
    );

    const listed = await listOwnerExports(USER, TENANT);
    assert.deepEqual(
      listed.map((row) => row.operationId).sort(),
      [availableOperation, failed].sort()
    );
    assert.equal(await getOwnerExport(USER, TENANT, expiredExport), null);
    assert.equal((await getOwnerExport(USER, TENANT, availableExport))?.fenceGeneration, 7);

    await pool.query("DELETE FROM exomem_exports WHERE id = $1", [expiredExport]);
    const store = new SqlLifecycleStore();
    const restore = await store.enqueue(TENANT, "restore", "pinned-restore", null, {
      inputReferenceEnvelope: encryptSecret(availableRef, {
        key,
        randomBytes: (size) => Buffer.alloc(size, 0x34),
      }),
      inputReferenceDigest: digestSecret(availableRef),
      restoreBinding: {
        exportId: availableExport,
        sourceCellId: CELL,
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        archiveSize: 1024,
      },
    });
    assert.equal(restore.inputExportId, availableExport);
    await pool.query(
      "UPDATE exomem_exports SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [availableExport]
    );
    assert.equal(await new SqlExportGcStore().claim({ owner: "gc-racer", leaseMs: 30_000 }), null);
  });
});
