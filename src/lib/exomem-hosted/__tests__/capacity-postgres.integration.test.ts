import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { acquireCapacityProviderWorkAtomic } from "../capacity-store";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
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
});
