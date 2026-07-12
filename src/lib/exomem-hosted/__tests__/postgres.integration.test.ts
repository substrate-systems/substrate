import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";
import {
  __setExomemSqlForTests,
  claimMagicLinkDelivery,
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  createMagicAccessToken,
  markMagicLinkDeliverySent,
  pruneStaleRateLimitBuckets,
  redeemMagicAccessTokenAtomic,
  releaseMagicLinkDelivery,
  takeRateLimit,
  type ExomemSql,
} from "../db";
import { SqlLifecycleStore } from "../lifecycle-store";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const CELL = "33333333-3333-4333-8333-333333333333";

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

  it("deletes a consumed invite and scrubs restore secrets after destruction", async () => {
    const session = "44444444-4444-4444-8444-444444444444";
    const restore = "55555555-5555-4555-8555-555555555555";
    const deletion = "66666666-6666-4666-8666-666666666666";
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
});
