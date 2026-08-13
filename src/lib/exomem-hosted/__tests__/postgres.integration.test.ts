import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  claimMagicLinkDelivery,
  clearExomemCheckoutTransaction,
  consumeDeletionConfirmationAtomic,
  createInviteRecord,
  createDeletionConfirmationToken,
  createMagicAccessToken,
  createTransferGrantRecord,
  markMagicLinkDeliverySent,
  pruneStaleRateLimitBuckets,
  recordExomemCheckoutTransaction,
  redeemInviteAtomic,
  redeemMagicAccessTokenAtomic,
  releaseMagicLinkDelivery,
  takeRateLimit,
  type ExomemSql,
} from "../db";
import { getExomemHostedContractionReadiness, SqlLifecycleStore } from "../lifecycle-store";
import { getOwnerExport, listOwnerExports } from "../durability";
import { SqlExportGcStore } from "../export-gc";
import { createSqlExomemPaddleEventStore, type ExomemPaddleSql } from "../paddle-event-store";
import {
  claimPaddleReconciliationTargets,
  releasePaddleReconciliationLease,
} from "../paddle-reconciliation-runtime";
import { FakeCellProvisioner } from "../provisioner";
import {
  LifecycleReconciler,
  expectedCellConfiguration,
  type LifecycleOperationType,
} from "../reconciler";
import { attachExistingOwnerAuthorizationAtomic } from "../oauth-store";
import {
  preflightRecoverExpiredReviewerCleanup,
  recoverExpiredReviewerCleanup,
} from "../operator-controls";
import { failCanaryAssignment } from "../agent-contract-canaries";
import { SensitiveSecret, digestSecret, encryptSecret } from "../security";
import { exomemContractFixture0350 } from "../gateway-contract-0-35-0";

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

  before(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 12 });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE users CASCADE");
    await pool.query("TRUNCATE TABLE exomem_agent_contract_candidates CASCADE");
    await pool.query("TRUNCATE TABLE exomem_client_artifacts CASCADE");
    await pool.query("TRUNCATE TABLE exomem_oauth_clients CASCADE");
    await pool.query("TRUNCATE TABLE rate_limit_events");
    await pool.query("TRUNCATE TABLE exomem_rate_limit_buckets");
  });

  async function seedExpiredReviewerCleanup(
    input: {
      tenantReviewer?: boolean;
      assignmentReviewer?: boolean;
      assignmentState?: "preparing" | "expired" | "active" | "failed";
      sourceState?: "waiting" | "failed_terminal";
      liveLease?: boolean;
    } = {}
  ) {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const cellId = randomUUID();
    const candidateId = randomUUID();
    const assignmentId = randomUUID();
    const sourceOperationId = randomUUID();
    const digest = "a".repeat(64);
    const assignmentState = input.assignmentState ?? "expired";
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `recovery-${userId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO exomem_tenants (
         id, owner_user_id, status, desired_state, marketplace_reviewer_purpose
       ) VALUES ($1, $2, 'provisioning', 'running', $3)`,
      [tenantId, userId, input.tenantReviewer ?? true]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'active', 'provisioning')`,
      [tenantId]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
       ) VALUES ($1, $2, 'provisioning', 'unbound', 'running', '1', 'test')`,
      [cellId, tenantId]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $2, $2, $2, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [candidateId, digest]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, created_at, expires_at,
         activated_at, ended_at
       ) VALUES ($1, $2, $3, 1, $4, 'test', '1', $5, $5, $5, $5, $6, $5,
                 now() - interval '2 hours',
                 CASE
                   WHEN $4 = 'expired' THEN now() - interval '1 second'
                   WHEN $4 = 'failed' THEN now() + interval '60 hours'
                   ELSE now() + interval '1 hour'
                 END,
                 CASE WHEN $4 = 'active' THEN now() ELSE NULL END,
                 CASE WHEN $4 IN ('expired', 'failed') THEN now() ELSE NULL END)`,
      [
        assignmentId,
        tenantId,
        candidateId,
        assignmentState,
        digest,
        input.assignmentReviewer ?? true,
      ]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, checkpoint, idempotency_key,
         fence_generation, provisioner_wire_protocol, lease_owner, lease_expires_at,
         target_candidate_id, target_assignment_id, target_assignment_generation,
         target_source_release, target_protocol_version, target_gateway_contract_digest,
         target_command_fingerprint, target_schema_digest, target_compatibility_digest
       ) VALUES ($1, $2, $3, 'provision', $4, 'candidate-cleanup', 'expired-reviewer-source',
                 1, 'exomem-cell-provisioner.v2',
                 CASE WHEN $5 THEN 'recovery-test-worker' ELSE NULL END,
                 CASE WHEN $5 THEN now() + interval '1 hour' ELSE NULL END,
                 $6, $7, 1, 'test', '1', $8, $8, $8, $8)`,
      [
        sourceOperationId,
        tenantId,
        cellId,
        input.sourceState ?? "waiting",
        input.liveLease ?? false,
        candidateId,
        assignmentId,
        digest,
      ]
    );
    return { userId, tenantId, cellId, candidateId, assignmentId, sourceOperationId };
  }

  it("keeps contraction blocked until unfinished v1 work and retained v1 exports drain", async () => {
    const candidate = "44444444-4444-4444-8444-444444444444";
    const activeOperation = "55555555-5555-4555-8555-555555555555";
    const completedOperation = "66666666-6666-4666-8666-666666666666";
    const terminalOperation = "77777777-7777-4777-8777-777777777777";
    const exportOperation = "88888888-8888-4888-8888-888888888888";
    const exportId = "99999999-9999-4999-8999-999999999999";
    const digest = "a".repeat(64);

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
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at
       ) VALUES ($1, 'live', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $2, $2, $2, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
      [candidate, digest]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, checkpoint, idempotency_key,
         fence_generation, provisioner_wire_protocol, target_candidate_id,
         target_source_release, target_protocol_version, target_gateway_contract_digest,
         target_command_fingerprint, target_schema_digest, target_compatibility_digest, completed_at
       ) VALUES
         ($1, $5, $6, 'seal', 'waiting', 'created', 'v1-active', 1,
          'exomem-cell-provisioner.v1', $7, 'test', '1', $8, $8, $8, $8, NULL),
         ($2, $5, $6, 'seal', 'succeeded', 'readiness-proved', 'v1-completed', 1,
          'exomem-cell-provisioner.v1', $7, 'test', '1', $8, $8, $8, $8, now()),
         ($3, $5, $6, 'seal', 'failed_terminal', 'created', 'v1-terminal', 1,
          'exomem-cell-provisioner.v1', $7, 'test', '1', $8, $8, $8, $8, now()),
         ($4, $5, $6, 'export', 'succeeded', 'readiness-proved', 'v1-export', 1,
          'exomem-cell-provisioner.v1', $7, 'test', '1', $8, $8, $8, $8, now())`,
      [
        activeOperation,
        completedOperation,
        terminalOperation,
        exportOperation,
        TENANT,
        CELL,
        candidate,
        digest,
      ]
    );
    await pool.query(
      `INSERT INTO exomem_exports (
         id, tenant_id, cell_id, operation_id, state,
         storage_reference_ciphertext, storage_reference_digest, archive_sha256, manifest_sha256, archive_size,
         encryption_scheme, integrity_verified, expires_at
       ) VALUES ($1, $2, $3, $4, 'available', $5, $6, $7, $8, 1,
                 'envelope-aes-256-gcm', true, now() + interval '1 day')`,
      [
        exportId,
        TENANT,
        CELL,
        exportOperation,
        JSON.stringify({ encrypted: true }),
        Buffer.alloc(32, 0x22),
        "b".repeat(64),
        "c".repeat(64),
      ]
    );

    assert.deepEqual(await getExomemHostedContractionReadiness(), {
      ready: false,
      unfinishedV1Operations: 1,
      retainedV1Exports: 1,
    });

    await pool.query(
      "UPDATE exomem_lifecycle_operations SET state = 'succeeded', completed_at = now() WHERE id = $1",
      [activeOperation]
    );
    await pool.query(
      `UPDATE exomem_exports
          SET state = 'deleted', storage_reference_ciphertext = NULL,
              storage_reference_digest = NULL, archive_sha256 = NULL, manifest_sha256 = NULL,
              archive_size = NULL, encryption_scheme = NULL, integrity_verified = NULL,
              deleted_at = now(), provider_deleted_at = now()
        WHERE id = $1`,
      [exportId]
    );
    assert.deepEqual(await getExomemHostedContractionReadiness(), {
      ready: true,
      unfinishedV1Operations: 0,
      retainedV1Exports: 0,
    });
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
    const ordinaryInvite = randomUUID();
    const bootstrapSession = randomUUID();
    const bootstrapInvite = randomUUID();
    const bootstrapCandidate = randomUUID();
    const bootstrapAssignment = randomUUID();
    const bootstrapStage = randomUUID();
    const bootstrapClient = randomUUID();
    const bootstrapGrant = randomUUID();
    const bootstrapAuthority = randomUUID();
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
         id, token_digest, email_normalized, entitlement_source,
         created_by_principal_digest, expires_at, consumed_at,
         consumed_by_user_id, redeemed_tenant_id, redeemed_session_id
       ) VALUES ($1, $2, $3, 'complimentary', $4, now() + interval '1 day', now(), $5, $6, $7)`,
      [
        ordinaryInvite,
        Buffer.alloc(32, 0x43),
        "owner@example.com",
        Buffer.alloc(32, 0x44),
        USER,
        TENANT,
        session,
      ]
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
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $2, $2, $2, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [bootstrapCandidate, "e".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, created_at, expires_at, ended_at
       ) VALUES ($1, $2, $3, 1, 'expired', 'test', '1', $4, $4, $4, $4,
                 true, $4, now() - interval '2 hours', now() - interval '1 second', now())`,
      [bootstrapAssignment, TENANT, bootstrapCandidate, "e".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_staged_client_releases (
         id, candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest,
         created_at, expires_at, ended_at
       ) VALUES ($1, $2, 'claude', 'expired', $3, $3, $3, $3, 'test', $3, $3,
                 now() - interval '2 hours', now() - interval '1 second', now())`,
      [bootstrapStage, bootstrapCandidate, "e".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_oauth_clients (id, client_id, admission_mode, redirect_uris, redirect_uris_digest)
       VALUES ($1, $2, 'pinned', '["http://127.0.0.1"]'::jsonb,
               digest(convert_to('["http://127.0.0.1"]', 'utf8'), 'sha256'))`,
      [bootstrapClient, `bootstrap-delete-${bootstrapClient}`]
    );
    await pool.query(
      `INSERT INTO exomem_sessions (
         id, user_id, tenant_id, session_digest, csrf_digest, expires_at
       ) VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
      [bootstrapSession, USER, TENANT, Buffer.alloc(32, 0x51), Buffer.alloc(32, 0x52)]
    );
    await pool.query(
      `INSERT INTO exomem_invites (
         id, token_digest, email_normalized, entitlement_source, created_by_principal_digest, expires_at,
         consumed_at, consumed_by_user_id, redeemed_tenant_id, redeemed_session_id
       ) VALUES ($1, $2, 'bootstrap@example.test', 'complimentary', $3, now() + interval '1 day',
                 now(), $4, $5, $6)`,
      [
        bootstrapInvite,
        Buffer.alloc(32, 0x53),
        Buffer.alloc(32, 0x54),
        USER,
        TENANT,
        bootstrapSession,
      ]
    );
    await pool.query(
      `INSERT INTO exomem_oauth_grants (id, user_id, tenant_id, client_id, resource, scopes)
       VALUES ($1, $2, $3, $4, 'https://substratesystems.io/api/exomem/mcp/v1', ARRAY['exomem.read'])`,
      [bootstrapGrant, USER, TENANT, bootstrapClient]
    );
    await pool.query(
      `INSERT INTO exomem_marketplace_reviewer_oauth_bootstrap_authorities (
         id, state, invite_id, candidate_id, candidate_profile_id, candidate_contract_digest,
         candidate_source_release, candidate_protocol_version, candidate_gateway_contract_digest,
         candidate_command_fingerprint, candidate_schema_digest, candidate_compatibility_digest,
         staged_client_release_id, stage_platform, stage_config_sha256, oauth_client_id,
         oauth_client_authority_version, oauth_client_config_sha256, redirect_uri_digest,
         operator_principal_digest, expires_at, consumed_at, outcome_tenant_id, outcome_assignment_id,
         outcome_assignment_generation, outcome_operation_id, outcome_session_id, outcome_grant_id
       ) VALUES ($1, 'consumed', $2, $3, 'hosted-alpha-agent-v1', $4, 'test', '1', $4, $4, $4, $4,
                 $5, 'claude', $4, $6, $7, $4, $8, $9, now() + interval '1 day', now(),
                 $10, $11, 1, $12, $13, $14)`,
      [
        bootstrapAuthority,
        bootstrapInvite,
        bootstrapCandidate,
        "e".repeat(64),
        bootstrapStage,
        bootstrapClient,
        randomUUID(),
        Buffer.alloc(32, 0x55),
        Buffer.alloc(32, 0x56),
        TENANT,
        bootstrapAssignment,
        deletion,
        bootstrapSession,
        bootstrapGrant,
      ]
    );
    const capacityPool = await pool.query<{ id: string }>(
      "SELECT id FROM exomem_capacity_pools WHERE pool_key = 'exomem-hosted-alpha'"
    );
    await pool.query(
      `UPDATE exomem_capacity_pools
       SET storage_capacity_bytes = 5, runtime_capacity_slots = 1,
           provision_reservation_capacity = 1, provision_claim_capacity = 1,
           reserved_storage_bytes = 5, reserved_runtime_slots = 1, reserved_provision_slots = 0
       WHERE id = $1`,
      [capacityPool.rows[0]!.id]
    );
    await pool.query(
      `INSERT INTO exomem_capacity_allocations (
         pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state
       ) VALUES ($1, $2, 5, 1, 0, 'occupied')`,
      [capacityPool.rows[0]!.id, TENANT]
    );

    const store = new SqlLifecycleStore();
    await assert.rejects(
      () => store.markCellState(deletion, "worker-delete", "deleted"),
      /exomem_invites_check1|outcome_session_id/
    );
    await pool.query("UPDATE exomem_sessions SET revoked_at = now() WHERE id = $1", [
      bootstrapSession,
    ]);
    assert.equal(await store.markCellState(deletion, "worker-delete", "deleted"), true);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT allocation.state, pool.reserved_storage_bytes, pool.reserved_runtime_slots
           FROM exomem_capacity_allocations AS allocation
           JOIN exomem_capacity_pools AS pool ON pool.id = allocation.pool_id
           WHERE allocation.tenant_id = $1`,
          [TENANT]
        )
      ).rows[0],
      { state: "released", reserved_storage_bytes: "0", reserved_runtime_slots: 0 }
    );

    const sessions = await pool.query<{
      ordinary_purged: boolean;
      ordinary_invite_purged: boolean;
      bootstrap_retained_revoked: boolean;
      bootstrap_linked: boolean;
      bootstrap_invite_retained_consumed: boolean;
      bootstrap_invite_linked: boolean;
    }>(
      `SELECT NOT EXISTS (SELECT 1 FROM exomem_sessions WHERE id = $1) AS ordinary_purged,
              NOT EXISTS (SELECT 1 FROM exomem_invites WHERE id = $2) AS ordinary_invite_purged,
              EXISTS (SELECT 1 FROM exomem_sessions WHERE id = $3 AND revoked_at IS NOT NULL) AS bootstrap_retained_revoked,
              EXISTS (
                SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
                WHERE id = $4 AND state = 'consumed' AND outcome_session_id = $3
              ) AS bootstrap_linked,
              EXISTS (
                SELECT 1 FROM exomem_invites
                WHERE id = $5 AND consumed_at IS NOT NULL AND revoked_at IS NULL
                  AND redeemed_tenant_id = $6 AND redeemed_session_id = $3
              ) AS bootstrap_invite_retained_consumed,
              EXISTS (
                SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
                WHERE id = $4 AND state = 'consumed' AND invite_id = $5
                  AND outcome_tenant_id = $6 AND outcome_session_id = $3
              ) AS bootstrap_invite_linked`,
      [session, ordinaryInvite, bootstrapSession, bootstrapAuthority, bootstrapInvite, TENANT]
    );
    assert.deepEqual(sessions.rows[0], {
      ordinary_purged: true,
      ordinary_invite_purged: true,
      bootstrap_retained_revoked: true,
      bootstrap_linked: true,
      bootstrap_invite_retained_consumed: true,
      bootstrap_invite_linked: true,
    });
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
    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    let consumed: Awaited<ReturnType<typeof consumeDeletionConfirmationAtomic>>;
    try {
      consumed = await consumeDeletionConfirmationAtomic({
        userId: USER,
        tenantId: TENANT,
        tokenDigest: digest,
      });
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
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
    const deletionOperation = await pool.query<{
      provisioner_wire_protocol: string;
      target_candidate_id: string | null;
    }>(
      `SELECT provisioner_wire_protocol, target_candidate_id
         FROM exomem_lifecycle_operations
        WHERE id = $1`,
      [consumed!.operationId]
    );
    assert.deepEqual(deletionOperation.rows, [
      { provisioner_wire_protocol: "exomem-cell-provisioner.v2", target_candidate_id: null },
    ]);

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
    const oauthBlock = await pool.query<{ blocked_reason: string }>(
      "SELECT blocked_reason FROM exomem_oauth_account_blocks WHERE tenant_id = $1",
      [TENANT]
    );
    assert.deepEqual(oauthBlock.rows, [{ blocked_reason: "lifecycle_deleted" }]);
  });

  it("runs lifecycle advance and persists a non-attempt-consuming provider wait", async () => {
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'provisioning', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at
       ) VALUES ('live', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $1, $2, $3, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', 'test', $3, $4, $5, $6)`,
      [CELL, TENANT, "d".repeat(64), "a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
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
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at
       ) VALUES ('live', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $1, $2, $3, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version, observed_gateway_contract_digest,
         observed_command_fingerprint, observed_schema_digest, observed_compatibility_digest
       ) VALUES ($1, $2, 'draining', 'bound', 'quiesced', '1', 'test', $3, $4, $5, $6)`,
      [CELL, TENANT, "d".repeat(64), "a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, 'hosted-alpha-agent-v1', 'test', '1', $2, $3, $4, true)`,
      [CELL, "a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );

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

  it("persists an immutable v2 target for a bound-cell operation", async () => {
    const commandFingerprint = "a".repeat(64);
    const schemaDigest = "b".repeat(64);
    const compatibilityDigest = "c".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    const liveCandidate = await pool.query<{ id: string }>(
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at
       ) VALUES (
         'live', 'hosted-alpha-agent-v1', 'https://agent.example.test', $1, $2, $3, $4, $5,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
       ) RETURNING id`,
      [
        exomemContractFixture0350.release,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
        exomemContractFixture0350.protocol,
      ]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', $3, $4, $5, $6, $7, $8)`,
      [
        CELL,
        TENANT,
        exomemContractFixture0350.protocol,
        exomemContractFixture0350.release,
        exomemContractFixture0350.digest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, 'hosted-alpha-agent-v1', $2, $3, $4, $5, $6, true)`,
      [
        CELL,
        exomemContractFixture0350.release,
        exomemContractFixture0350.protocol,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at, retired_at
       ) VALUES (
         'retired', 'hosted-alpha-agent-v1', 'https://agent-history.example.test', $1, $2, $3, $4, $5,
         '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now()
       )`,
      [
        exomemContractFixture0350.release,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
        exomemContractFixture0350.protocol,
      ]
    );

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "TrUe";
    try {
      const store = new SqlLifecycleStore();
      const operationTypes: LifecycleOperationType[] = [
        "suspend",
        "resume",
        "rotate_credential",
        "export",
        "stop",
        "seal",
      ];
      const operations = await Promise.all(
        operationTypes.map((operationType) =>
          store.enqueue(TENANT, operationType, `v2-bound-cell-${operationType}`)
        )
      );
      for (const queued of operations) {
        assert.equal(queued.provisionerWireProtocol, "exomem-cell-provisioner.v2");
        assert.ok(queued.target?.candidateId);
        assert.equal(queued.target?.candidateId, liveCandidate.rows[0]!.id);
        assert.equal(queued.target?.sourceRelease, exomemContractFixture0350.release);
        assert.equal(queued.target?.protocolVersion, exomemContractFixture0350.protocol);
        assert.equal(queued.target?.gatewayContractDigest, exomemContractFixture0350.digest);
        assert.equal(queued.target?.commandFingerprint, commandFingerprint);
        assert.equal(queued.target?.schemaDigest, schemaDigest);
        assert.equal(queued.target?.compatibilityDigest, compatibilityDigest);
      }

      process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "false";
      const retry = await store.claim({
        owner: "retry-worker",
        leaseMs: 30_000,
        maxAttempts: 6,
        tenantId: TENANT,
      });
      assert.equal(retry?.provisionerWireProtocol, "exomem-cell-provisioner.v2");
      assert.deepEqual(retry?.target, operations[0]?.target);
      const deletionDigest = Buffer.alloc(32, 0x72);
      assert.ok(
        await createDeletionConfirmationToken({
          userId: USER,
          tenantId: TENANT,
          tokenDigest: deletionDigest,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        })
      );
      const deletion = await consumeDeletionConfirmationAtomic({
        userId: USER,
        tenantId: TENANT,
        tokenDigest: deletionDigest,
      });
      assert.ok(deletion);
      const deletionTarget = await pool.query<{ target_candidate_id: string }>(
        "SELECT target_candidate_id FROM exomem_lifecycle_operations WHERE id = $1",
        [deletion!.operationId]
      );
      assert.equal(deletionTarget.rows[0]?.target_candidate_id, liveCandidate.rows[0]!.id);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("uses a bound cell's active pending-candidate assignment for v2 maintenance", async () => {
    const candidateId = "77777777-7777-4777-8777-777777777791";
    const assignmentId = "77777777-7777-4777-8777-777777777792";
    const commandFingerprint = "a".repeat(64);
    const schemaDigest = "b".repeat(64);
    const compatibilityDigest = "c".repeat(64);
    const gatewayDigest = "d".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test', '2026.07.30',
                 $2, $3, $4, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [candidateId, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', '2026.07.30', $3, $4, $5, $6)`,
      [CELL, TENANT, gatewayDigest, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
       ) VALUES ($1, $2, $3, 7, 'active', '2026.07.30', '1', $4, $5, $6, $7,
                 false, $8, now() + interval '1 hour', now())`,
      [
        assignmentId,
        TENANT,
        candidateId,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
        gatewayDigest,
        "e".repeat(64),
      ]
    );

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      const operation = await new SqlLifecycleStore().enqueue(
        TENANT,
        "seal",
        "v2-pending-assignment"
      );
      assert.deepEqual(operation.target, {
        candidateId,
        assignmentId,
        assignmentGeneration: 7,
        sourceRelease: "2026.07.30",
        protocolVersion: "1",
        gatewayContractDigest: gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      });
      const deletionDigest = Buffer.alloc(32, 0x73);
      assert.ok(
        await createDeletionConfirmationToken({
          userId: USER,
          tenantId: TENANT,
          tokenDigest: deletionDigest,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        })
      );
      const deletion = await consumeDeletionConfirmationAtomic({
        userId: USER,
        tenantId: TENANT,
        tokenDigest: deletionDigest,
      });
      assert.ok(deletion);
      const deletionTarget = await pool.query<{
        provisioner_wire_protocol: string;
        target_candidate_id: string;
        target_assignment_id: string;
        target_assignment_generation: string;
      }>(
        `SELECT provisioner_wire_protocol, target_candidate_id, target_assignment_id,
                target_assignment_generation::text
           FROM exomem_lifecycle_operations
          WHERE id = $1`,
        [deletion!.operationId]
      );
      assert.deepEqual(deletionTarget.rows, [
        {
          provisioner_wire_protocol: "exomem-cell-provisioner.v2",
          target_candidate_id: candidateId,
          target_assignment_id: assignmentId,
          target_assignment_generation: "7",
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("retains the exact installed target across retired and reimported candidates", async () => {
    const originalCandidateId = "77777777-7777-4777-8777-777777777793";
    const commandFingerprint = "a".repeat(64);
    const schemaDigest = "b".repeat(64);
    const compatibilityDigest = "c".repeat(64);
    const gatewayDigest = "d".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at, retired_at
       ) VALUES ($1, 'retired', 'hosted-alpha-agent-v1', 'https://agent-origin.example.test',
                 '2026.07.30', $2, $3, $4, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
      [originalCandidateId, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at
       ) VALUES ('live', 'hosted-alpha-agent-v1', 'https://agent-reimport.example.test',
                 '2026.07.30', $1, $2, $3, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
      [commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', '2026.07.30', $3, $4, $5, $6)`,
      [CELL, TENANT, gatewayDigest, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         tenant_id, cell_id, operation_type, state, checkpoint, idempotency_key, fence_generation,
         completed_at, target_candidate_id, target_source_release, target_protocol_version,
         target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
         target_compatibility_digest
       ) VALUES ($1, $2, 'provision', 'succeeded', 'readiness-proved', 'installed-origin', 1,
                 now(), $3, '2026.07.30', '1', $4, $5, $6, $7)`,
      [
        TENANT,
        CELL,
        originalCandidateId,
        gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      const maintenance = await new SqlLifecycleStore().enqueue(
        TENANT,
        "seal",
        "origin-bound-seal"
      );
      assert.equal(maintenance.target?.candidateId, originalCandidateId);
      const deletionDigest = Buffer.alloc(32, 0x74);
      assert.ok(
        await createDeletionConfirmationToken({
          userId: USER,
          tenantId: TENANT,
          tokenDigest: deletionDigest,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        })
      );
      const deletion = await consumeDeletionConfirmationAtomic({
        userId: USER,
        tenantId: TENANT,
        tokenDigest: deletionDigest,
      });
      assert.ok(deletion);
      const target = await pool.query<{ target_candidate_id: string }>(
        "SELECT target_candidate_id FROM exomem_lifecycle_operations WHERE id = $1",
        [deletion!.operationId]
      );
      assert.equal(target.rows[0]?.target_candidate_id, originalCandidateId);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("fails closed when distinct installed target identities tie for a bound cell", async () => {
    const firstCandidateId = "77777777-7777-4777-8777-777777777794";
    const secondCandidateId = "77777777-7777-4777-8777-777777777795";
    const commandFingerprint = "a".repeat(64);
    const schemaDigest = "b".repeat(64);
    const compatibilityDigest = "c".repeat(64);
    const gatewayDigest = "d".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    for (const [id, endpoint] of [
      [firstCandidateId, "https://agent-origin-one.example.test"],
      [secondCandidateId, "https://agent-origin-two.example.test"],
    ]) {
      await pool.query(
        `INSERT INTO exomem_agent_contract_candidates (
           id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
           compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
           promoted_at, retired_at
         ) VALUES ($1, 'retired', 'hosted-alpha-agent-v1', $2, '2026.07.30', $3, $4, $5, '1',
                   '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
        [id, endpoint, commandFingerprint, schemaDigest, compatibilityDigest]
      );
    }
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', '2026.07.30', $3, $4, $5, $6)`,
      [CELL, TENANT, gatewayDigest, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
    for (const [candidateId, key] of [
      [firstCandidateId, "ambiguous-origin-one"],
      [secondCandidateId, "ambiguous-origin-two"],
    ]) {
      await pool.query(
        `INSERT INTO exomem_lifecycle_operations (
           tenant_id, cell_id, operation_type, state, checkpoint, idempotency_key, fence_generation,
           completed_at, target_candidate_id, target_source_release, target_protocol_version,
           target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
           target_compatibility_digest
         ) VALUES ($1, $2, 'provision', 'succeeded', 'readiness-proved', $3, 1,
                   '2026-07-30T00:00:00.000Z', $4, '2026.07.30', '1', $5, $6, $7, $8)`,
        [
          TENANT,
          CELL,
          key,
          candidateId,
          gatewayDigest,
          commandFingerprint,
          schemaDigest,
          compatibilityDigest,
        ]
      );
    }

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = "true";
    try {
      await assert.rejects(
        new SqlLifecycleStore().enqueue(TENANT, "seal", "ambiguous-origin-seal")
      );
      await pool.query(
        `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
        [USER, TENANT, Buffer.alloc(32, 0x91), Buffer.alloc(32, 0x92)]
      );
      const deletionDigest = Buffer.alloc(32, 0x93);
      assert.ok(
        await createDeletionConfirmationToken({
          userId: USER,
          tenantId: TENANT,
          tokenDigest: deletionDigest,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        })
      );
      await assert.rejects(
        consumeDeletionConfirmationAtomic({
          userId: USER,
          tenantId: TENANT,
          tokenDigest: deletionDigest,
        }),
        /lifecycle target is required for new operation|exomem_lifecycle_v2_target_check/i
      );
      const unchanged = await pool.query<{
        status: string;
        desired_state: string;
        fence_generation: string;
        confirmation_available: boolean;
        session_active: boolean;
        deletion_operations: string;
      }>(
        `SELECT tenant.status,
                tenant.desired_state,
                tenant.fence_generation::text,
                (SELECT consumed_at IS NULL AND revoked_at IS NULL
                   FROM exomem_access_tokens
                  WHERE token_digest = $2) AS confirmation_available,
                (SELECT bool_and(revoked_at IS NULL)
                   FROM exomem_sessions
                  WHERE tenant_id = tenant.id) AS session_active,
                (SELECT count(*)::text
                   FROM exomem_lifecycle_operations
                  WHERE tenant_id = tenant.id AND operation_type = 'delete') AS deletion_operations
           FROM exomem_tenants AS tenant
          WHERE tenant.id = $1`,
        [TENANT, deletionDigest]
      );
      assert.deepEqual(unchanged.rows, [
        {
          status: "active",
          desired_state: "running",
          fence_generation: "1",
          confirmation_available: true,
          session_active: true,
          deletion_operations: "0",
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }
  });

  it("persists expired export release as mandatory recovery and completes it atomically", async () => {
    const operationId = "44444444-4444-4444-8444-444444444480";
    const envelopeKey = Buffer.alloc(32, 0x32);
    const credential = "postgres-expired-export-credential";
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, fence_generation, legacy_unmetered)
       VALUES ($1, $2, 'suspended', 'suspended', 4, true)`,
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
      provisionMode: "serve",
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
      `INSERT INTO exomem_agent_contract_candidates (
         state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at
       ) VALUES ('live', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $1, $2, $3, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
      ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state,
         protocol_version, release_version, provider_ref,
         service_credential_ciphertext, service_credential_digest,
         observed_gateway_contract_digest, observed_command_fingerprint, observed_schema_digest,
         observed_compatibility_digest
       ) VALUES ($1, $2, 'active', 'bound', 'running', '1', 'test', 'provider-ref', $3, $4, $5, $6, $7, $8)`,
      [
        CELL,
        TENANT,
        JSON.stringify({ encrypted: true }),
        Buffer.alloc(32, 0x21),
        "d".repeat(64),
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
      ]
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

  it("treats an exact active assignment and binding as an idempotent lost-ack retry", async () => {
    const prior = "77777777-7777-4777-8777-777777777771";
    const replacement = "77777777-7777-4777-8777-777777777772";
    const contract = "77777777-7777-4777-8777-777777777773";
    const assignment = "77777777-7777-4777-8777-777777777774";
    const operation = "77777777-7777-4777-8777-777777777775";
    const gatewayDigest = "a".repeat(64);
    const commandFingerprint = "b".repeat(64);
    const schemaDigest = "c".repeat(64);
    const compatibilityDigest = "d".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, legacy_unmetered, marketplace_reviewer_purpose)
       VALUES ($1, $2, 'active', 'running', true, true)`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
         observed_schema_digest, observed_compatibility_digest
       ) VALUES
         ($1, $3, 'retired', 'retiring', 'quiesced', '0', '2026.07.11', 'CELL_READY', NULL, NULL, NULL, NULL),
         ($2, $3, 'active', 'bound', 'running', '0', '2026.07.11', 'CELL_READY', NULL, NULL, NULL, NULL)`,
      [prior, replacement, TENANT]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
      replacement,
      TENANT,
    ]);
    await pool.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, 'hosted-alpha-agent-v1', '2026.07.11', '0', $2, $3, $4, true)`,
      [replacement, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test',
                 '2026.07.11', $2, $3, $4, '0', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [contract, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
       ) VALUES ($1, $2, $3, 1, 'active', '2026.07.11', '0', $4, $5, $6, $7,
                 true, $8, now() + interval '1 hour', now())`,
      [
        assignment,
        TENANT,
        contract,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
        gatewayDigest,
        "e".repeat(64),
      ]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, expected_previous_cell_id, operation_type, state, idempotency_key,
         fence_generation, checkpoint, lease_owner, lease_expires_at,
         target_candidate_id, target_assignment_id, target_assignment_generation,
         target_source_release, target_protocol_version, target_gateway_contract_digest,
         target_command_fingerprint, target_schema_digest, target_compatibility_digest
       ) VALUES ($1, $2, $3, $4, 'provision', 'running', 'lost-bind-ack', 1, 'readiness-proved',
                 'retry-worker', now() + interval '1 hour', $5, $6, 1, '2026.07.11', '0', $7, $8, $9, $10)`,
      [
        operation,
        TENANT,
        replacement,
        prior,
        contract,
        assignment,
        gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );

    assert.equal(await new SqlLifecycleStore().bindCandidate(operation, "retry-worker"), true);
    const state = await pool.query<{
      assignment_state: string;
      bound_cell_id: string;
      replacement_routable: boolean;
    }>(
      `SELECT assignment.state AS assignment_state, tenant.bound_cell_id,
              observation.routable AS replacement_routable
       FROM exomem_agent_contract_rollout_assignments AS assignment
       JOIN exomem_tenants AS tenant ON tenant.id = assignment.tenant_id
       JOIN exomem_routable_cell_contracts AS observation
         ON observation.cell_id = tenant.bound_cell_id AND observation.profile_id = 'hosted-alpha-agent-v1'
       WHERE assignment.id = $1`,
      [assignment]
    );
    assert.deepEqual(state.rows, [
      { assignment_state: "active", bound_cell_id: replacement, replacement_routable: true },
    ]);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT observed_gateway_contract_digest, observed_command_fingerprint,
                  observed_schema_digest, observed_compatibility_digest
           FROM exomem_cells WHERE id = $1`,
          [replacement]
        )
      ).rows,
      [
        {
          observed_gateway_contract_digest: null,
          observed_command_fingerprint: null,
          observed_schema_digest: null,
          observed_compatibility_digest: null,
        },
      ]
    );
  });

  it("refuses every strict-v1 bind exception outside the exact reviewer null-observation path", async () => {
    const gatewayDigest = "a".repeat(64);
    const commandFingerprint = "b".repeat(64);
    const schemaDigest = "c".repeat(64);
    const compatibilityDigest = "d".repeat(64);
    const cases: Array<{
      name: string;
      tenantReviewer?: boolean;
      assignmentReviewer?: boolean;
      expiresAt?: string;
      operationGeneration?: number;
      observations?: Array<string | null>;
    }> = [
      { name: "ordinary tenant", tenantReviewer: false },
      { name: "ordinary assignment", assignmentReviewer: false },
      { name: "expired assignment", expiresAt: "now() - interval '1 second'" },
      { name: "wrong assignment generation", operationGeneration: 2 },
      { name: "partial observations", observations: [gatewayDigest, null, null, null] },
      {
        name: "exact non-null observations",
        observations: [gatewayDigest, commandFingerprint, schemaDigest, compatibilityDigest],
      },
    ];

    for (const scenario of cases) {
      const userId = randomUUID();
      const tenantId = randomUUID();
      const cellId = randomUUID();
      const candidateId = randomUUID();
      const assignmentId = randomUUID();
      const operationId = randomUUID();
      await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
        userId,
        `v1-refusal-${scenario.name}-${userId}@example.test`,
      ]);
      await pool.query(
        `INSERT INTO exomem_tenants (
           id, owner_user_id, status, desired_state, legacy_unmetered, marketplace_reviewer_purpose
         ) VALUES ($1, $2, 'provisioning', 'running', true, $3)`,
        [tenantId, userId, scenario.tenantReviewer ?? true]
      );
      await pool.query(
        `INSERT INTO exomem_cells (
           id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
           readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
           observed_schema_digest, observed_compatibility_digest
         ) VALUES ($1, $2, 'provisioning', 'unbound', 'running', '0', '2026.07.11', 'CELL_READY',
                   $3, $4, $5, $6)`,
        [cellId, tenantId, ...(scenario.observations ?? [null, null, null, null])]
      );
      await pool.query(
        `INSERT INTO exomem_agent_contract_candidates (
           id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
           compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
         ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test',
                   '2026.07.11', $2, $3, $4, '0', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
        [candidateId, commandFingerprint, schemaDigest, compatibilityDigest]
      );
      await pool.query(
        `INSERT INTO exomem_agent_contract_rollout_assignments (
           id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
           command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
           marketplace_reviewer_purpose, created_by_principal_digest, created_at, expires_at
         ) VALUES ($1, $2, $3, 1, 'preparing', '2026.07.11', '0', $4, $5, $6, $7,
                   $8, $9, now() - interval '2 hours',
                   ${scenario.expiresAt ?? "now() + interval '1 hour'"})`,
        [
          assignmentId,
          tenantId,
          candidateId,
          commandFingerprint,
          schemaDigest,
          compatibilityDigest,
          gatewayDigest,
          scenario.assignmentReviewer ?? true,
          "e".repeat(64),
        ]
      );
      await pool.query(
        `INSERT INTO exomem_lifecycle_operations (
           id, tenant_id, cell_id, operation_type, state, idempotency_key, fence_generation,
           checkpoint, lease_owner, lease_expires_at, target_candidate_id, target_assignment_id,
           target_assignment_generation, target_source_release, target_protocol_version,
           target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
           target_compatibility_digest
         ) VALUES ($1, $2, $3, 'provision', 'running', $4, 1, 'readiness-proved',
                   'v1-refusal', now() + interval '1 hour', $5, $6, $7, '2026.07.11', '0',
                   $8, $9, $10, $11)`,
        [
          operationId,
          tenantId,
          cellId,
          `v1-refusal-${operationId}`,
          candidateId,
          assignmentId,
          scenario.operationGeneration ?? 1,
          gatewayDigest,
          commandFingerprint,
          schemaDigest,
          compatibilityDigest,
        ]
      );
      assert.equal(
        await new SqlLifecycleStore().bindCandidate(operationId, "v1-refusal"),
        false,
        scenario.name
      );
    }
  });

  it("atomically recovers the exact expired reviewer cleanup and replays its target-free delete", async () => {
    const userId = randomUUID();
    const tenantId = randomUUID();
    const cellId = randomUUID();
    const candidateId = randomUUID();
    const assignmentId = randomUUID();
    const sourceOperationId = randomUUID();
    const requestId = randomUUID();
    const digest = "a".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      userId,
      `recovery-${userId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO exomem_tenants (
         id, owner_user_id, status, desired_state, marketplace_reviewer_purpose
       ) VALUES ($1, $2, 'provisioning', 'running', true)`,
      [tenantId, userId]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'active', 'provisioning')`,
      [tenantId]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
       ) VALUES ($1, $2, 'provisioning', 'unbound', 'running', '1', 'test')`,
      [cellId, tenantId]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock
       ) VALUES ($1, 'pending', 'hosted-alpha-agent-v1', 'https://agent.example.test', 'test',
                 $2, $2, $2, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [candidateId, digest]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, created_at, expires_at, ended_at
       ) VALUES ($1, $2, $3, 1, 'expired', 'test', '1', $4, $4, $4, $4,
                 true, $4, now() - interval '2 hours', now() - interval '1 second', now())`,
      [assignmentId, tenantId, candidateId, digest]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, operation_type, state, checkpoint, idempotency_key,
         fence_generation, provisioner_wire_protocol, target_candidate_id, target_assignment_id,
         target_assignment_generation, target_source_release, target_protocol_version,
         target_gateway_contract_digest, target_command_fingerprint, target_schema_digest,
         target_compatibility_digest
       ) VALUES ($1, $2, $3, 'provision', 'waiting', 'candidate-cleanup', 'expired-reviewer-source',
                 1, 'exomem-cell-provisioner.v2', $4, $5, 1, 'test', '1', $6, $6, $6, $6)`,
      [sourceOperationId, tenantId, cellId, candidateId, assignmentId, digest]
    );

    const first = await recoverExpiredReviewerCleanup({
      sourceOperationId,
      expectedFence: 1,
      requestId,
      operatorPrincipalDigest: Buffer.alloc(32, 0x71),
    });
    assert.equal(first?.outcome, "enqueued");
    assert.ok(first?.operationId);
    const state = await pool.query<{
      status: string;
      desired_state: string;
      fence_generation: string;
      source_state: string;
      source_error: string;
      operation_type: string;
      target_candidate_id: string | null;
      target_assignment_id: string | null;
      audit_count: string;
      deleted_at: Date | null;
      cell_lifecycle_state: string;
    }>(
      `SELECT tenant.status, tenant.desired_state, tenant.fence_generation::text,
              source.state AS source_state, source.error_code AS source_error,
              deletion.operation_type, deletion.target_candidate_id::text, deletion.target_assignment_id::text,
              (SELECT count(*)::text FROM exomem_audit_events WHERE request_id = $3::uuid) AS audit_count,
              tenant.deleted_at, cell.lifecycle_state AS cell_lifecycle_state
       FROM exomem_tenants AS tenant
       JOIN exomem_lifecycle_operations AS source ON source.id = $1::uuid
       JOIN exomem_lifecycle_operations AS deletion ON deletion.id = $2::uuid
       JOIN exomem_cells AS cell ON cell.id = $5::uuid
       WHERE tenant.id = $4::uuid`,
      [sourceOperationId, first!.operationId, requestId, tenantId, cellId]
    );
    assert.deepEqual(state.rows[0], {
      status: "deletion_pending",
      desired_state: "deleted",
      fence_generation: "2",
      source_state: "failed_terminal",
      source_error: "DELETION_SUPERSEDED",
      operation_type: "delete",
      target_candidate_id: null,
      target_assignment_id: null,
      audit_count: "2",
      deleted_at: null,
      cell_lifecycle_state: "provisioning",
    });

    const replay = await recoverExpiredReviewerCleanup({
      sourceOperationId,
      expectedFence: 1,
      requestId: randomUUID(),
      operatorPrincipalDigest: Buffer.alloc(32, 0x71),
    });
    assert.deepEqual(replay, { outcome: "replayed", operationId: first!.operationId });
    const deleteCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM exomem_lifecycle_operations
       WHERE tenant_id = $1::uuid AND operation_type = 'delete'`,
      [tenantId]
    );
    assert.equal(deleteCount.rows[0]?.count, "1");
  });

  it("recovers only a terminal failed reviewer assignment without extending its immutable expiry", async () => {
    const seed = await seedExpiredReviewerCleanup({ assignmentState: "preparing" });
    const beforeFailure = await pool.query<{ expires_at: Date }>(
      `SELECT expires_at
       FROM exomem_agent_contract_rollout_assignments
       WHERE id = $1::uuid`,
      [seed.assignmentId]
    );
    assert.equal(
      await failCanaryAssignment({ assignmentId: seed.assignmentId, expectedVersion: 1 }),
      true
    );
    const assignment = await pool.query<{ state: string; expires_at: Date; ended_at: Date | null }>(
      `SELECT state, expires_at, ended_at
       FROM exomem_agent_contract_rollout_assignments
       WHERE id = $1::uuid`,
      [seed.assignmentId]
    );
    assert.equal(assignment.rows[0]?.state, "failed");
    assert.ok(assignment.rows[0]?.ended_at);
    assert.ok(assignment.rows[0]!.expires_at.getTime() > Date.now());
    assert.equal(
      assignment.rows[0]!.expires_at.getTime(),
      beforeFailure.rows[0]!.expires_at.getTime()
    );
    assert.deepEqual(
      await preflightRecoverExpiredReviewerCleanup({
        sourceOperationId: seed.sourceOperationId,
        expectedFence: 1,
      }),
      { eligible: true }
    );

    const first = await recoverExpiredReviewerCleanup({
      sourceOperationId: seed.sourceOperationId,
      expectedFence: 1,
      requestId: randomUUID(),
      operatorPrincipalDigest: Buffer.alloc(32, 0x71),
    });
    assert.equal(first?.outcome, "enqueued");
    assert.ok(first?.operationId);
    const deletion = await pool.query<{
      fence_generation: string;
      target_candidate_id: string | null;
      target_assignment_id: string | null;
    }>(
      `SELECT fence_generation::text, target_candidate_id::text, target_assignment_id::text
       FROM exomem_lifecycle_operations WHERE id = $1::uuid`,
      [first!.operationId]
    );
    assert.deepEqual(deletion.rows, [
      { fence_generation: "2", target_candidate_id: null, target_assignment_id: null },
    ]);

    assert.deepEqual(
      await recoverExpiredReviewerCleanup({
        sourceOperationId: seed.sourceOperationId,
        expectedFence: 1,
        requestId: randomUUID(),
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      }),
      { outcome: "replayed", operationId: first!.operationId }
    );
    const deleteCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM exomem_lifecycle_operations
       WHERE tenant_id = $1::uuid AND operation_type = 'delete'`,
      [seed.tenantId]
    );
    assert.equal(deleteCount.rows[0]?.count, "1");
  });

  it("refuses stale, leased, bound, ambiguous, healthy, customer, and terminal cleanup without mutation", async () => {
    const cases: Array<{
      name: string;
      seed?: Parameters<typeof seedExpiredReviewerCleanup>[0];
      expectedFence?: number;
      mutate?: (seed: Awaited<ReturnType<typeof seedExpiredReviewerCleanup>>) => Promise<void>;
    }> = [
      { name: "stale fence", expectedFence: 2 },
      { name: "live lease", seed: { liveLease: true } },
      { name: "customer tenant", seed: { tenantReviewer: false } },
      {
        name: "nonreviewer failed assignment",
        seed: { assignmentState: "failed", assignmentReviewer: false },
      },
      { name: "eligible assignment", seed: { assignmentState: "active" } },
      { name: "terminal source", seed: { sourceState: "failed_terminal" } },
      {
        name: "bound cell",
        mutate: async ({ tenantId, cellId }) => {
          await pool.query(`UPDATE exomem_cells SET routing_state = 'bound' WHERE id = $1`, [
            cellId,
          ]);
          await pool.query(`UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2`, [
            cellId,
            tenantId,
          ]);
        },
      },
      {
        name: "ambiguous cell",
        mutate: async ({ tenantId }) => {
          await pool.query(
            `INSERT INTO exomem_cells (
               tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
             ) VALUES ($1, 'provisioning', 'unbound', 'running', '1', 'test')`,
            [tenantId]
          );
        },
      },
    ];
    for (const scenario of cases) {
      await pool.query("TRUNCATE TABLE users CASCADE");
      const seed = await seedExpiredReviewerCleanup(scenario.seed);
      await scenario.mutate?.(seed);
      const before = await pool.query<{
        status: string;
        desired_state: string;
        fence_generation: string;
        operation_count: string;
      }>(
        `SELECT tenant.status, tenant.desired_state, tenant.fence_generation::text,
                (SELECT count(*)::text FROM exomem_lifecycle_operations WHERE tenant_id = tenant.id) AS operation_count
         FROM exomem_tenants AS tenant WHERE tenant.id = $1`,
        [seed.tenantId]
      );
      assert.deepEqual(
        await preflightRecoverExpiredReviewerCleanup({
          sourceOperationId: seed.sourceOperationId,
          expectedFence: scenario.expectedFence ?? 1,
        }),
        { eligible: false },
        scenario.name
      );
      assert.equal(
        await recoverExpiredReviewerCleanup({
          sourceOperationId: seed.sourceOperationId,
          expectedFence: scenario.expectedFence ?? 1,
          requestId: randomUUID(),
          operatorPrincipalDigest: Buffer.alloc(32, 0x71),
        }),
        null,
        scenario.name
      );
      const after = await pool.query(
        `SELECT tenant.status, tenant.desired_state, tenant.fence_generation::text,
                (SELECT count(*)::text FROM exomem_lifecycle_operations WHERE tenant_id = tenant.id) AS operation_count
         FROM exomem_tenants AS tenant WHERE tenant.id = $1`,
        [seed.tenantId]
      );
      assert.deepEqual(after.rows, before.rows, scenario.name);
    }
  });

  it("serializes recovery behind a shared reviewer or OAuth cohort issuer lock", async () => {
    const seed = await seedExpiredReviewerCleanup();
    const issuer = await pool.connect();
    try {
      await issuer.query("BEGIN");
      await issuer.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))"
      );
      const recovery = recoverExpiredReviewerCleanup({
        sourceOperationId: seed.sourceOperationId,
        expectedFence: 1,
        requestId: randomUUID(),
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      });
      await waitForBlockedQuery(
        pool,
        "%pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))%"
      );
      await issuer.query("COMMIT");
      assert.equal((await recovery)?.outcome, "enqueued");
      const authority = await pool.query<{ blocked: boolean; usable_session_count: string }>(
        `SELECT EXISTS (
            SELECT 1 FROM exomem_oauth_account_blocks WHERE tenant_id = $1::uuid
          ) AS blocked,
          (SELECT count(*)::text FROM exomem_sessions
           WHERE tenant_id = $1::uuid AND revoked_at IS NULL AND expires_at > now()) AS usable_session_count`,
        [seed.tenantId]
      );
      assert.deepEqual(authority.rows, [{ blocked: true, usable_session_count: "0" }]);
    } finally {
      await issuer.query("ROLLBACK").catch(() => undefined);
      issuer.release();
    }
  });

  it("revokes an outstanding reviewer invite for the stranded tenant owner", async () => {
    const seed = await seedExpiredReviewerCleanup();
    const tokenDigest = Buffer.alloc(32, 0x61);
    const invite = await createInviteRecord({
      tokenDigest,
      emailNormalized: `recovery-${seed.userId}@example.test`,
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: true,
      operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      expiresAt: new Date(Date.now() + 60_000),
    });

    assert.equal(
      (
        await recoverExpiredReviewerCleanup({
          sourceOperationId: seed.sourceOperationId,
          expectedFence: 1,
          requestId: randomUUID(),
          operatorPrincipalDigest: Buffer.alloc(32, 0x71),
        })
      )?.outcome,
      "enqueued"
    );
    const state = await pool.query<{ revoked: boolean; consumed: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked, consumed_at IS NOT NULL AS consumed
       FROM exomem_invites WHERE id = $1`,
      [invite.inviteId]
    );
    assert.deepEqual(state.rows, [{ revoked: true, consumed: false }]);
    await assert.rejects(
      () =>
        createInviteRecord({
          tokenDigest: Buffer.alloc(32, 0x62),
          emailNormalized: `recovery-${seed.userId}@example.test`,
          entitlementSource: "complimentary",
          capabilities: [],
          resourceLimits: {},
          marketplaceReviewerPurpose: true,
          operatorPrincipalDigest: Buffer.alloc(32, 0x71),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      /createInviteRecord returned no row/
    );
  });

  it("serializes reviewer invite issuance ahead of recovery and revokes the issued invite", async () => {
    const seed = await seedExpiredReviewerCleanup();
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      const issued = createInviteRecord({
        tokenDigest: Buffer.alloc(32, 0x62),
        emailNormalized: `recovery-${seed.userId}@example.test`,
        entitlementSource: "complimentary",
        capabilities: [],
        resourceLimits: {},
        marketplaceReviewerPurpose: true,
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await waitForBlockedQuery(
        pool,
        "%pg_advisory_xact_lock_shared(hashtext('exomem-hosted-alpha-cohort'))%"
      );
      const recovery = recoverExpiredReviewerCleanup({
        sourceOperationId: seed.sourceOperationId,
        expectedFence: 1,
        requestId: randomUUID(),
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      });
      await waitForBlockedQuery(
        pool,
        "%pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))%"
      );
      await blocker.query("COMMIT");
      const invite = await issued;
      assert.equal((await recovery)?.outcome, "enqueued");
      const state = await pool.query<{ revoked: boolean }>(
        "SELECT revoked_at IS NOT NULL AS revoked FROM exomem_invites WHERE id = $1",
        [invite.inviteId]
      );
      assert.deepEqual(state.rows, [{ revoked: true }]);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("serializes reviewer invite redemption behind recovery and creates no session", async () => {
    const seed = await seedExpiredReviewerCleanup();
    const tokenDigest = Buffer.alloc(32, 0x63);
    await createInviteRecord({
      tokenDigest,
      emailNormalized: `recovery-${seed.userId}@example.test`,
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: true,
      operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))");
      const recovery = recoverExpiredReviewerCleanup({
        sourceOperationId: seed.sourceOperationId,
        expectedFence: 1,
        requestId: randomUUID(),
        operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      });
      await waitForBlockedQuery(
        pool,
        "%pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))%"
      );
      const redemption = redeemInviteAtomic({
        tokenDigest,
        sessionDigest: Buffer.alloc(32, 0x64),
        csrfDigest: Buffer.alloc(32, 0x65),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      });
      await blocker.query("COMMIT");
      assert.equal((await recovery)?.outcome, "enqueued");
      assert.equal(await redemption, null);
      const sessions = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM exomem_sessions WHERE tenant_id = $1",
        [seed.tenantId]
      );
      assert.equal(sessions.rows[0]?.count, "0");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("refuses reviewer invite redemption for a deletion-pending blocked tenant", async () => {
    const seed = await seedExpiredReviewerCleanup();
    const tokenDigest = Buffer.alloc(32, 0x66);
    const invite = await createInviteRecord({
      tokenDigest,
      emailNormalized: `recovery-${seed.userId}@example.test`,
      entitlementSource: "complimentary",
      capabilities: [],
      resourceLimits: {},
      marketplaceReviewerPurpose: true,
      operatorPrincipalDigest: Buffer.alloc(32, 0x71),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await pool.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [seed.tenantId]
    );
    await pool.query(
      `INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason)
       VALUES ($1, $2, 'lifecycle_deleted')`,
      [seed.tenantId, seed.userId]
    );

    assert.equal(
      await redeemInviteAtomic({
        tokenDigest,
        sessionDigest: Buffer.alloc(32, 0x67),
        csrfDigest: Buffer.alloc(32, 0x68),
        sessionExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );
    const state = await pool.query<{ consumed: boolean; session_count: string }>(
      `SELECT invite.consumed_at IS NOT NULL AS consumed,
              (SELECT count(*)::text FROM exomem_sessions WHERE tenant_id = $2) AS session_count
       FROM exomem_invites AS invite WHERE invite.id = $1`,
      [invite.inviteId, seed.tenantId]
    );
    assert.deepEqual(state.rows, [{ consumed: false, session_count: "0" }]);
  });

  it("recovers with residual reviewer authority and atomically revokes its complete OAuth lineage", async () => {
    const seed = await seedExpiredReviewerCleanup();
    const clientId = randomUUID();
    const stageId = randomUUID();
    const credentialId = randomUUID();
    const sessionId = randomUUID();
    const transactionId = randomUUID();
    const digest = "a".repeat(64);
    await pool.query(
      `INSERT INTO exomem_oauth_clients (id, client_id, admission_mode, redirect_uris, redirect_uris_digest)
       VALUES ($1, $2, 'pinned', '["http://127.0.0.1"]'::jsonb,
               digest(convert_to('["http://127.0.0.1"]', 'utf8'), 'sha256'))`,
      [clientId, `recovery-transaction-${clientId}`]
    );
    await pool.query(
      `INSERT INTO exomem_staged_client_releases (
         id, candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
         contract_sha256, plugin_version, oauth_client_config_sha256, created_by_principal_digest,
         created_at, expires_at, ended_at
       ) VALUES ($1, $2, 'claude', 'expired', $3, $3, $3, $3, 'test', $3, $3,
                 now() - interval '2 hours', now() - interval '1 second', now())`,
      [stageId, seed.candidateId, digest]
    );
    await pool.query(
      `INSERT INTO exomem_marketplace_reviewer_credentials (
         id, provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version,
         fixture_payload_digest, created_by_principal_digest, expires_at, revoked_at, credential_kind,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id, oauth_client_id
       ) VALUES ($1, 'anthropic', $2, '$argon2id$test', $3, $4, 'fixture', $5, $2,
         now() + interval '5 days', NULL, 'internal_canary', $6, $7, 1, $8, $9)`,
      [
        credentialId,
        Buffer.alloc(32, 0x42),
        seed.userId,
        seed.tenantId,
        digest,
        seed.candidateId,
        seed.assignmentId,
        stageId,
        clientId,
      ]
    );
    await pool.query(
      `INSERT INTO exomem_sessions (
         id, user_id, tenant_id, session_digest, csrf_digest, expires_at
       ) VALUES ($1, $2, $3, $4, $5, now() + interval '5 days')`,
      [sessionId, seed.userId, seed.tenantId, Buffer.alloc(32, 0x44), Buffer.alloc(32, 0x45)]
    );
    await pool.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         id, transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at,
         redeemed_session_id, candidate_id, assignment_id, assignment_generation, staged_client_release_id, reviewer_credential_id
       ) VALUES ($1, $2, $3, 'http://127.0.0.1', 'https://substratesystems.io/api/exomem/mcp/v1',
                 ARRAY['exomem.read'], $2, '{}'::jsonb, $2, $2, 'verifier', now() + interval '1 hour',
                 $4, $5, $6, 1, $7, $8)`,
      [
        transactionId,
        Buffer.alloc(32, 0x43),
        clientId,
        sessionId,
        seed.candidateId,
        seed.assignmentId,
        stageId,
        credentialId,
      ]
    );

    const graph = await pool.query<{ grant_id: string; family_id: string; code_id: string }>(
      `WITH grant_row AS (
         INSERT INTO exomem_oauth_grants (
           user_id, tenant_id, client_id, resource, scopes, refresh_allowed, authorization_transaction_id,
           reviewer_credential_id, candidate_id, assignment_id, assignment_generation, staged_client_release_id
         ) VALUES ($1, $2, $3, 'https://substratesystems.io/api/exomem/mcp/v1', ARRAY['exomem.read'], true,
                   $4, $5, $6, $7, 1, $8) RETURNING id
       ), family AS (
         INSERT INTO exomem_oauth_token_families (
           grant_id, client_id, expires_at, candidate_id, assignment_id, assignment_generation,
           staged_client_release_id, reviewer_credential_id
         ) SELECT id, $3, now() + interval '5 days', $6, $7, 1, $8, $5 FROM grant_row RETURNING id, grant_id
       ), code AS (
         INSERT INTO exomem_oauth_authorization_codes (
           code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, refresh_allowed, expires_at,
           reviewer_credential_id, candidate_id, assignment_id, assignment_generation, staged_client_release_id
         ) SELECT $9, grant_id, $3, 'http://127.0.0.1', 'https://substratesystems.io/api/exomem/mcp/v1',
                  'verifier', true, now() + interval '5 days', $5, $6, $7, 1, $8 FROM family RETURNING id
       ), refresh AS (
         INSERT INTO exomem_oauth_refresh_tokens (
           refresh_digest, family_id, expires_at, candidate_id, assignment_id, assignment_generation,
           staged_client_release_id, oauth_client_id, reviewer_credential_id
         ) SELECT $10, id, now() + interval '5 days', $6, $7, 1, $8, $3, $5 FROM family
       ), access AS (
         INSERT INTO exomem_oauth_access_tokens (
           access_digest, grant_id, family_id, client_id, resource, scopes, expires_at,
           candidate_id, assignment_id, assignment_generation, staged_client_release_id, reviewer_credential_id
         ) SELECT $11, grant_id, id, $3, 'https://substratesystems.io/api/exomem/mcp/v1', ARRAY['exomem.read'],
                  now() + interval '5 days', $6, $7, 1, $8, $5 FROM family
       ) SELECT family.grant_id, family.id AS family_id, code.id AS code_id FROM family CROSS JOIN code`,
      [
        seed.userId,
        seed.tenantId,
        clientId,
        transactionId,
        credentialId,
        seed.candidateId,
        seed.assignmentId,
        stageId,
        Buffer.alloc(32, 0x46),
        Buffer.alloc(32, 0x47),
        Buffer.alloc(32, 0x48),
      ]
    );
    const otherUserId = randomUUID();
    const otherTenantId = randomUUID();
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
      otherUserId,
      `recovery-other-${otherUserId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [otherTenantId, otherUserId]
    );
    const crossTenant = await pool.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (
         user_id, tenant_id, client_id, resource, scopes, reviewer_credential_id,
         candidate_id, assignment_id, assignment_generation, staged_client_release_id
       ) VALUES ($1, $2, $3, 'https://substratesystems.io/api/exomem/mcp/v1', ARRAY['exomem.read'],
                 $4, $5, $6, 1, $7) RETURNING id`,
      [
        otherUserId,
        otherTenantId,
        clientId,
        credentialId,
        seed.candidateId,
        seed.assignmentId,
        stageId,
      ]
    );
    const unrelated = await pool.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
       VALUES ($1, $2, $3, 'https://unrelated.example.test', ARRAY['exomem.read']) RETURNING id`,
      [otherUserId, otherTenantId, clientId]
    );

    assert.deepEqual(
      await preflightRecoverExpiredReviewerCleanup({
        sourceOperationId: seed.sourceOperationId,
        expectedFence: 1,
      }),
      { eligible: true }
    );
    assert.equal(
      (
        await recoverExpiredReviewerCleanup({
          sourceOperationId: seed.sourceOperationId,
          expectedFence: 1,
          requestId: randomUUID(),
          operatorPrincipalDigest: Buffer.alloc(32, 0x71),
        })
      )?.outcome,
      "enqueued"
    );
    const revoked = await pool.query<{
      credential_revoked: boolean;
      session_revoked: boolean;
      transaction_consumed: boolean;
      grant_revoked: boolean;
      code_consumed: boolean;
      family_revoked: boolean;
      access_revoked: boolean;
      refresh_consumed: boolean;
    }>(
      `SELECT credential.revoked_at IS NOT NULL AS credential_revoked,
              session.revoked_at IS NOT NULL AS session_revoked,
              transaction.consumed_at IS NOT NULL AS transaction_consumed,
              grant_row.revoked_at IS NOT NULL AS grant_revoked,
              code.consumed_at IS NOT NULL AS code_consumed,
              family.revoked_at IS NOT NULL AS family_revoked,
              access.revoked_at IS NOT NULL AS access_revoked,
              refresh.consumed_at IS NOT NULL AS refresh_consumed
       FROM exomem_marketplace_reviewer_credentials AS credential
       JOIN exomem_sessions AS session ON session.id = $2
       JOIN exomem_oauth_authorization_transactions AS transaction ON transaction.id = $3
       JOIN exomem_oauth_grants AS grant_row ON grant_row.id = $4
       JOIN exomem_oauth_authorization_codes AS code ON code.id = $5
       JOIN exomem_oauth_token_families AS family ON family.id = $6
       JOIN exomem_oauth_access_tokens AS access ON access.family_id = family.id
       JOIN exomem_oauth_refresh_tokens AS refresh ON refresh.family_id = family.id
       WHERE credential.id = $1`,
      [
        credentialId,
        sessionId,
        transactionId,
        graph.rows[0]!.grant_id,
        graph.rows[0]!.code_id,
        graph.rows[0]!.family_id,
      ]
    );
    assert.deepEqual(revoked.rows, [
      {
        credential_revoked: true,
        session_revoked: true,
        transaction_consumed: true,
        grant_revoked: true,
        code_consumed: true,
        family_revoked: true,
        access_revoked: true,
        refresh_consumed: true,
      },
    ]);
    const crossTenantState = await pool.query<{ exact_revoked: boolean; unrelated_live: boolean }>(
      `SELECT (SELECT revoked_at IS NOT NULL FROM exomem_oauth_grants WHERE id = $1) AS exact_revoked,
              (SELECT revoked_at IS NULL FROM exomem_oauth_grants WHERE id = $2) AS unrelated_live`,
      [crossTenant.rows[0]!.id, unrelated.rows[0]!.id]
    );
    assert.deepEqual(crossTenantState.rows, [{ exact_revoked: true, unrelated_live: true }]);
  });

  it("refuses a retired pinned candidate without changing the old binding or routability", async () => {
    const prior = "88888888-8888-4888-8888-888888888881";
    const replacement = "88888888-8888-4888-8888-888888888882";
    const contract = "88888888-8888-4888-8888-888888888883";
    const operation = "88888888-8888-4888-8888-888888888884";
    const gatewayDigest = "a".repeat(64);
    const commandFingerprint = "b".repeat(64);
    const schemaDigest = "c".repeat(64);
    const compatibilityDigest = "d".repeat(64);
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_cells (
         id, tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version,
         readiness_code, observed_gateway_contract_digest, observed_command_fingerprint,
         observed_schema_digest, observed_compatibility_digest
       ) VALUES
         ($1, $3, 'active', 'bound', 'running', '0', '2026.07.11', 'CELL_READY', $4, $5, $6, $7),
         ($2, $3, 'provisioning', 'unbound', 'running', '0', '2026.07.11', 'CELL_READY', $4, $5, $6, $7)`,
      [
        prior,
        replacement,
        TENANT,
        gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );
    await pool.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [prior, TENANT]);
    await pool.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, 'hosted-alpha-agent-v1', '2026.07.11', '0', $2, $3, $4, true)`,
      [prior, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
         promoted_at, retired_at
       ) VALUES ($1, 'retired', 'hosted-alpha-agent-v1', 'https://agent.example.test',
                 '2026.07.11', $2, $3, $4, '0', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now(), now())`,
      [contract, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, cell_id, expected_previous_cell_id, operation_type, state, idempotency_key,
         fence_generation, checkpoint, lease_owner, lease_expires_at,
         target_candidate_id, target_source_release, target_protocol_version, target_gateway_contract_digest,
         target_command_fingerprint, target_schema_digest, target_compatibility_digest
       ) VALUES ($1, $2, $3, $4, 'provision', 'running', 'retired-target', 1, 'readiness-proved',
                 'retired-worker', now() + interval '1 hour', $5, '2026.07.11', '0', $6, $7, $8, $9)`,
      [
        operation,
        TENANT,
        replacement,
        prior,
        contract,
        gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );

    assert.equal(await new SqlLifecycleStore().bindCandidate(operation, "retired-worker"), false);
    const state = await pool.query<{
      bound_cell_id: string;
      prior_routing_state: string;
      prior_routable: boolean;
      replacement_routing_state: string;
    }>(
      `SELECT tenant.bound_cell_id, prior.routing_state AS prior_routing_state,
              observation.routable AS prior_routable, replacement.routing_state AS replacement_routing_state
       FROM exomem_tenants AS tenant
       JOIN exomem_cells AS prior ON prior.id = $1
       JOIN exomem_cells AS replacement ON replacement.id = $2
       JOIN exomem_routable_cell_contracts AS observation
         ON observation.cell_id = prior.id AND observation.profile_id = 'hosted-alpha-agent-v1'
       WHERE tenant.id = $3`,
      [prior, replacement, TENANT]
    );
    assert.deepEqual(state.rows, [
      {
        bound_cell_id: prior,
        prior_routing_state: "bound",
        prior_routable: true,
        replacement_routing_state: "unbound",
      },
    ]);
  });

  it("uses a persisted older lifecycle target despite a newer reconciler configuration", async () => {
    const candidate = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const operation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const gatewayDigest = "a".repeat(64);
    const commandFingerprint = "b".repeat(64);
    const schemaDigest = "c".repeat(64);
    const compatibilityDigest = "d".repeat(64);
    await pool.query(
      "ALTER TABLE exomem_lifecycle_operations DROP CONSTRAINT IF EXISTS exomem_lifecycle_operations_provisioner_wire_protocol_check"
    );
    await pool.query(
      "DROP TRIGGER IF EXISTS exomem_lifecycle_provisioner_wire_protocol_immutable ON exomem_lifecycle_operations"
    );
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants
         (id, owner_user_id, status, desired_state, legacy_unmetered)
       VALUES ($1, $2, 'provisioning', 'running', true)`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock, promoted_at
       ) VALUES ($1, 'live', 'hosted-alpha-agent-v1', 'https://agent.example.test',
                 '2026.07.11', $2, $3, $4, '0', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`,
      [candidate, commandFingerprint, schemaDigest, compatibilityDigest]
    );
    await pool.query(
      `INSERT INTO exomem_lifecycle_operations (
         id, tenant_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol,
         target_candidate_id, target_source_release, target_protocol_version, target_gateway_contract_digest,
         target_command_fingerprint, target_schema_digest, target_compatibility_digest
       ) VALUES ($1, $2, 'provision', 'pinned-older-target', 1, 'exomem-cell-provisioner.v2',
                 $3, '2026.07.11', '0', $4, $5, $6, $7)`,
      [
        operation,
        TENANT,
        candidate,
        gatewayDigest,
        commandFingerprint,
        schemaDigest,
        compatibilityDigest,
      ]
    );
    const reconciler = new LifecycleReconciler({
      store: new SqlLifecycleStore(),
      provisioner: new FakeCellProvisioner(),
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "2026.07.12",
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      envelopeKey: Buffer.alloc(32, 0x61),
      randomBytes: (size) => Buffer.alloc(size, 0x51),
    });
    for (let index = 0; index < 5; index += 1) {
      await reconciler.reconcileOne({ owner: `older-target-${index}`, tenantId: TENANT });
    }

    const state = await pool.query<{
      state: string;
      release_version: string;
      protocol_version: string;
    }>(
      `SELECT operation.state, cell.release_version, cell.protocol_version
       FROM exomem_lifecycle_operations AS operation
       JOIN exomem_cells AS cell ON cell.id = operation.cell_id
       WHERE operation.id = $1`,
      [operation]
    );
    assert.deepEqual(state.rows, [
      { state: "succeeded", release_version: "2026.07.11", protocol_version: "0" },
    ]);
  });

  it("blocks ordinary live-client authorization during an active rollout until fresh post-rollout authorization", async () => {
    const candidate = "99999999-9999-4999-8999-999999999991";
    const assignment = "99999999-9999-4999-8999-999999999992";
    const clientConfig = "f".repeat(64);
    const candidateLocks = {
      claude: {
        platform: "claude",
        artifact_sha256: "a".repeat(64),
        archive_sha256: "b".repeat(64),
        compatibility_sha256: "c".repeat(64),
        schema_contract_sha256: "d".repeat(64),
        plugin_version: "1.0.0",
      },
      openai: {
        platform: "openai",
        artifact_sha256: "e".repeat(64),
        archive_sha256: "f".repeat(64),
        compatibility_sha256: "c".repeat(64),
        schema_contract_sha256: "d".repeat(64),
        plugin_version: "1.0.0",
        registered_app_id_sha256: "9".repeat(64),
      },
    };
    await pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [USER, "owner@example.com"]);
    await pool.query(
      `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
       VALUES ($1, $2, 'active', 'running')`,
      [TENANT, USER]
    );
    await pool.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'complimentary', 'active', 'active')`,
      [TENANT]
    );
    const session = await pool.query<{ id: string }>(
      `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '1 hour') RETURNING id`,
      [USER, TENANT, Buffer.alloc(32, 0x81), Buffer.alloc(32, 0x82)]
    );
    const client = await pool.query<{ id: string }>(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
         client_platform, oauth_client_config_sha256
       ) VALUES ('ordinary-rollout-client', 'pinned', true,
                 '["https://client.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://client.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                 'claude', $1)
       RETURNING id`,
      [clientConfig]
    );
    await pool.query(
      `INSERT INTO exomem_agent_contract_candidates (
         id, state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
         compatibility_digest, protocol_version, mcp_protocol_versions, contract, claude_package_lock,
         claude_archive_lock, openai_package_lock, openai_archive_lock, promoted_at
       ) VALUES ($1, 'live', 'hosted-alpha-agent-v1', 'https://agent.example.test', '2026.07.12',
                 $2, $3, $4, '1', '["2025-11-25"]'::jsonb, '{}'::jsonb,
                 $5::jsonb, $5::jsonb, $6::jsonb, $6::jsonb, now())`,
      [
        candidate,
        "1".repeat(64),
        "d".repeat(64),
        "c".repeat(64),
        JSON.stringify(candidateLocks.claude),
        JSON.stringify(candidateLocks.openai),
      ]
    );
    for (const lock of [candidateLocks.claude, candidateLocks.openai]) {
      await pool.query(
        `INSERT INTO exomem_client_artifacts (
           platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
           plugin_version, client_identity_sha256, paired_run_hmac_sha256,
           exomem_identity_hmac_sha256, tenant_hmac_sha256, install_url, evidence_sha256,
           result_sha256, contract_candidate_id, registered_app_id_sha256,
           oauth_client_config_sha256, observed_at, promoted_at
         ) VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                  'https://example.test/install', $11, $12, $13, $14, $15, now(), now())`,
        [
          lock.platform,
          lock.artifact_sha256,
          lock.archive_sha256,
          lock.compatibility_sha256,
          lock.schema_contract_sha256,
          lock.plugin_version,
          "1".repeat(64),
          "2".repeat(64),
          "3".repeat(64),
          "4".repeat(64),
          "5".repeat(64),
          "6".repeat(64),
          lock.platform === "openai" ? candidate : null,
          lock.platform === "openai" ? candidateLocks.openai.registered_app_id_sha256 : null,
          clientConfig,
        ]
      );
    }
    await pool.query(
      `INSERT INTO exomem_agent_contract_rollout_assignments (
         id, tenant_id, candidate_id, generation, state, source_release, protocol_version,
         command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
         marketplace_reviewer_purpose, created_by_principal_digest, expires_at, activated_at
       ) VALUES ($1, $2, $3, 1, 'active', '2026.07.12', '1', $4, $5, $6, $7,
                 false, $8, now() + interval '1 hour', now())`,
      [
        assignment,
        TENANT,
        candidate,
        "1".repeat(64),
        "d".repeat(64),
        "c".repeat(64),
        "a".repeat(64),
        "e".repeat(64),
      ]
    );
    await pool.query(
      `INSERT INTO exomem_oauth_authorization_transactions (
         transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest,
         state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
       ) VALUES ($1, $2, 'https://client.example.test/callback', 'https://resource.example.test',
                 ARRAY['exomem.read'], $3, '{}'::jsonb, $4, $5, 'challenge', now() + interval '1 hour')`,
      [
        Buffer.alloc(32, 0x83),
        client.rows[0]!.id,
        Buffer.alloc(32, 0x84),
        Buffer.alloc(32, 0x85),
        Buffer.alloc(32, 0x86),
      ]
    );

    assert.equal(
      await attachExistingOwnerAuthorizationAtomic({
        sessionId: session.rows[0]!.id,
        transactionDigest: Buffer.alloc(32, 0x83),
        codeDigest: Buffer.alloc(32, 0x87),
        codeExpiresAt: new Date(Date.now() + 60_000),
      }),
      null
    );

    await pool.query(
      `UPDATE exomem_agent_contract_rollout_assignments
       SET state = 'retired', ended_at = now(), activated_at = NULL
       WHERE id = $1`,
      [assignment]
    );
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: session.rows[0]!.id,
      transactionDigest: Buffer.alloc(32, 0x83),
      codeDigest: Buffer.alloc(32, 0x87),
      codeExpiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(attached?.tenantId, TENANT);
  });
});
