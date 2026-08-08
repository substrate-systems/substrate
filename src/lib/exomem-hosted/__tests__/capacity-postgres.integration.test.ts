import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { acquireCapacityProviderWorkAtomic } from "../capacity-store";
import { admitSelfServeOrWaitlistAtomic } from "../db";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { EXOMEM_ALPHA_CAPACITY as ALPHA } from "../oauth-admission";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function interactiveTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
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

async function runningProvision(legacyUnmetered = false): Promise<string> {
  const email = `capacity-${randomUUID()}@example.test`;
  const user = await pool!.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
  const tenant = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id, legacy_unmetered) VALUES ($1, $2) RETURNING id",
    [user.rows[0].id, legacyUnmetered]
  );
  const operation = await pool!.query(
    `INSERT INTO exomem_lifecycle_operations (
       tenant_id, operation_type, state, idempotency_key, fence_generation,
       checkpoint, lease_owner, lease_expires_at
     ) VALUES ($1, 'provision', 'running', $2, 1, 'candidate-created', 'worker-a', now() + interval '1 hour')
     RETURNING id`,
    [tenant.rows[0].id, randomUUID()]
  );
  return operation.rows[0].id;
}

async function meteredRunningProvision(checkpoint = "candidate-created"): Promise<string> {
  const operationId = await runningProvision();
  const operation = await pool!.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM exomem_lifecycle_operations WHERE id = $1",
    [operationId]
  );
  const poolRow = await pool!.query<{ id: string }>(
    "SELECT id FROM exomem_capacity_pools WHERE pool_key = 'exomem-hosted-alpha'"
  );
  await pool!.query(
    `UPDATE exomem_capacity_pools
     SET storage_capacity_bytes = 100, runtime_capacity_slots = 1,
         provision_reservation_capacity = 1, provision_claim_capacity = 1,
         reserved_storage_bytes = 1, reserved_runtime_slots = 1, reserved_provision_slots = 1,
         configured_at = now(), updated_at = now()
     WHERE id = $1`,
    [poolRow.rows[0]!.id]
  );
  await pool!.query(
    `INSERT INTO exomem_capacity_allocations (
       pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state, operation_id
     ) VALUES ($1, $2, 1, 1, 1, 'reserved', $3)`,
    [poolRow.rows[0]!.id, operation.rows[0]!.tenant_id, operationId]
  );
  await pool!.query("UPDATE exomem_lifecycle_operations SET checkpoint = $2 WHERE id = $1", [
    operationId,
    checkpoint,
  ]);
  return operationId;
}

describe("capacity lifecycle PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `capacity_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("rejects arbitrary allocation-less rows but admits only the explicit legacy marker", async () => {
    const unmarked = await runningProvision();
    assert.equal(
      await acquireCapacityProviderWorkAtomic({
        operationId: unmarked,
        leaseOwner: "worker-a",
        kind: "initial_provision",
        leaseSeconds: 60,
      }),
      "conflict"
    );

    const legacy = await runningProvision(true);
    assert.equal(
      await acquireCapacityProviderWorkAtomic({
        operationId: legacy,
        leaseOwner: "worker-a",
        kind: "initial_provision",
        leaseSeconds: 60,
      }),
      "legacy"
    );
  });

  it("serializes the final provider claim and fences a stale checkpoint", async () => {
    const first = await meteredRunningProvision();
    const second = await meteredRunningProvision();
    const [firstResult, secondResult] = await Promise.all([
      acquireCapacityProviderWorkAtomic({
        operationId: first,
        leaseOwner: "worker-a",
        kind: "initial_provision",
        leaseSeconds: 300,
      }),
      acquireCapacityProviderWorkAtomic({
        operationId: second,
        leaseOwner: "worker-a",
        kind: "initial_provision",
        leaseSeconds: 300,
      }),
    ]);
    assert.deepEqual(new Set([firstResult, secondResult]), new Set(["acquired", "exhausted"]));

    const stale = await meteredRunningProvision("provider-converged");
    assert.equal(
      await acquireCapacityProviderWorkAtomic({
        operationId: stale,
        leaseOwner: "worker-a",
        kind: "initial_provision",
        leaseSeconds: 300,
      }),
      "conflict"
    );
  });

  // Self-serve admission decides before money changes hands, so these exercise
  // the SQL headroom arithmetic directly: unit tests stub the decision away, and
  // an off-by-one here oversells places that were already paid for.
  async function configurePool(input: {
    runtimeCapacity: number;
    reservedRuntime: number;
  }): Promise<void> {
    await pool!.query(
      `UPDATE exomem_capacity_pools
       SET storage_capacity_bytes = $1, reserved_storage_bytes = $2,
           runtime_capacity_slots = $3, reserved_runtime_slots = $4,
           provision_reservation_capacity = $3, reserved_provision_slots = $4,
           configured_at = now(), updated_at = now()
       WHERE pool_key = 'exomem-hosted-alpha'`,
      [
        ALPHA.storageBytes * input.runtimeCapacity,
        ALPHA.storageBytes * input.reservedRuntime,
        input.runtimeCapacity,
        input.reservedRuntime,
      ]
    );
  }

  // The suite shares one schema, so admission tests start from a known pool.
  async function resetAdmissionState(): Promise<void> {
    await pool!.query("DELETE FROM exomem_waitlist_entries");
    await pool!.query("DELETE FROM exomem_invites WHERE self_serve");
  }

  function admissionFor(email: string, fill: number) {
    return admitSelfServeOrWaitlistAtomic({
      tokenDigest: Buffer.alloc(32, fill),
      emailNormalized: email,
      capabilities: ["capture"],
      resourceLimits: { storageBytes: ALPHA.storageBytes },
      principalDigest: Buffer.alloc(32, 0xfe),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      storageBytes: ALPHA.storageBytes,
      runtimeSlots: ALPHA.runtimeSlots,
      provisionSlots: ALPHA.provisionReservationSlots,
    });
  }

  it("admits only up to free capacity and waitlists the rest", async () => {
    await resetAdmissionState();
    await configurePool({ runtimeCapacity: 2, reservedRuntime: 0 });

    const first = await admissionFor("self-serve-1@example.test", 0x01);
    const second = await admissionFor("self-serve-2@example.test", 0x02);
    // Two places, two admissions — outstanding invites are counted, so the
    // third visitor is refused a place nobody could provision.
    const third = await admissionFor("self-serve-3@example.test", 0x03);

    assert.equal(first.outcome, "admitted");
    assert.equal(second.outcome, "admitted");
    assert.equal(third.outcome, "waitlisted");
    assert.equal(third.outcome === "waitlisted" && third.position, 1);
  });

  it("counts outstanding invites against already-reserved capacity", async () => {
    await resetAdmissionState();
    // One place, already reserved by a redeemed tenant: nothing is free even
    // though no self-serve invite is outstanding.
    await configurePool({ runtimeCapacity: 1, reservedRuntime: 1 });
    const result = await admissionFor("self-serve-full@example.test", 0x04);
    assert.equal(result.outcome, "waitlisted");
  });

  it("keeps one visitor to one place across repeat requests", async () => {
    await resetAdmissionState();
    await configurePool({ runtimeCapacity: 1, reservedRuntime: 0 });
    const first = await admissionFor("self-serve-repeat@example.test", 0x05);
    assert.equal(first.outcome, "admitted");
    // Asking twice must supersede rather than accumulate, or one impatient
    // visitor could exhaust the pool by refreshing.
    const second = await admissionFor("self-serve-repeat@example.test", 0x06);
    assert.equal(second.outcome, "admitted");

    const outstanding = await pool!.query(
      `SELECT count(*)::int AS n FROM exomem_invites
       WHERE self_serve AND consumed_at IS NULL AND revoked_at IS NULL`
    );
    assert.equal(outstanding.rows[0].n, 1);

    const other = await admissionFor("self-serve-other@example.test", 0x07);
    assert.equal(other.outcome, "waitlisted");
  });

  it("fails closed to the waitlist when the pool is unconfigured", async () => {
    await resetAdmissionState();
    await pool!.query(
      `UPDATE exomem_capacity_pools SET configured_at = NULL WHERE pool_key = 'exomem-hosted-alpha'`
    );
    // Unknown capacity must never read as free capacity.
    const result = await admissionFor("self-serve-unconfigured@example.test", 0x08);
    assert.equal(result.outcome, "waitlisted");
  });

  it("reports a stable queue position and does not duplicate a waitlist row", async () => {
    await resetAdmissionState();
    await configurePool({ runtimeCapacity: 0, reservedRuntime: 0 });
    const first = await admissionFor("self-serve-q1@example.test", 0x09);
    const second = await admissionFor("self-serve-q2@example.test", 0x0a);
    assert.deepEqual(
      [
        first.outcome === "waitlisted" && first.position,
        second.outcome === "waitlisted" && second.position,
      ],
      [1, 2]
    );
    const again = await admissionFor("self-serve-q1@example.test", 0x0b);
    assert.equal(again.outcome === "waitlisted" && again.position, 1);
    const rows = await pool!.query(
      `SELECT count(*)::int AS n FROM exomem_waitlist_entries WHERE email_normalized = $1`,
      ["self-serve-q1@example.test"]
    );
    assert.equal(rows.rows[0].n, 1);
  });
});
