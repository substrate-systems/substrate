import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Task 3.1: migration 0056 is the schema of record for C1-C1d. This suite
// exercises the generation/notify trigger, the one-active-cell-per-tenant
// partial unique index, and the check constraints — all against real
// PostgreSQL, per the shared contract in the Exomem design.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

function cellId(fill: string): string {
  // 16 lowercase base32 (a-z2-7) characters, per C1's "identity and placement".
  return fill.repeat(16).slice(0, 16);
}

async function newTenant(): Promise<string> {
  const email = `cloud-cells-${randomUUID()}@example.test`;
  const user = await pool!.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    email,
  ]);
  const tenant = await pool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [user.rows[0]!.id]
  );
  return tenant.rows[0]!.id;
}

describe("Exomem Cloud cells schema PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `cloud_cells_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
  });

  after(async () => {
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("seeds exactly the one C1d rollout row", async () => {
    const rows = await pool!.query("SELECT id, paused FROM exomem_cloud_rollout");
    assert.deepEqual(rows.rows, [{ id: 1, paused: false }]);
  });

  it("rejects a second C1d row", async () => {
    await assert.rejects(
      pool!.query("INSERT INTO exomem_cloud_rollout (id) VALUES (2)"),
      /violates check constraint/
    );
  });

  it("rejects a malformed cell_id", async () => {
    const tenantId = await newTenant();
    await assert.rejects(
      pool!.query(
        "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
        ["NOT-BASE32", tenantId]
      ),
      /violates check constraint/
    );
  });

  it("rejects an invalid desired_state, observed_state and hold_kind", async () => {
    const tenantId = await newTenant();
    await assert.rejects(
      pool!.query(
        "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'booting')",
        [cellId("a"), tenantId]
      ),
      /violates check constraint/
    );
    await assert.rejects(
      pool!.query(
        `INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, observed_state)
         VALUES ($1, $2, 'running', 'booting')`,
        [cellId("b"), tenantId]
      ),
      /violates check constraint/
    );
    await assert.rejects(
      pool!.query(
        `INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, hold_kind)
         VALUES ($1, $2, 'running', 'reboot')`,
        [cellId("c"), tenantId]
      ),
      /violates check constraint/
    );
  });

  it("allows only one non-deleted cell row per tenant", async () => {
    const tenantId = await newTenant();
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [cellId("d"), tenantId]
    );
    await assert.rejects(
      pool!.query(
        "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'stopped')",
        [cellId("e"), tenantId]
      ),
      /duplicate key value violates unique constraint/
    );

    // Once the first row is deleted, the tenant may hold a fresh one.
    await pool!.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1",
      [cellId("d")]
    );
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [cellId("e"), tenantId]
    );
    const active = await pool!.query(
      "SELECT cell_id FROM exomem_cloud_cells WHERE tenant_id = $1 AND desired_state <> 'deleted'",
      [tenantId]
    );
    assert.deepEqual(active.rows, [{ cell_id: cellId("e") }]);
  });

  it("bumps generation and notifies only when a desired column changes", async () => {
    const tenantId = await newTenant();
    const id = cellId("f");
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    const listener = await pool!.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => {
      if (message.channel === "exomem_cloud_cells" && message.payload) {
        notifications.push(message.payload);
      }
    });
    await listener.query("LISTEN exomem_cloud_cells");

    // An observed-only write (cellctl's shape) must not touch generation.
    await pool!.query(
      "UPDATE exomem_cloud_cells SET observed_state = 'running', ready = true WHERE cell_id = $1",
      [id]
    );
    // A desired-column write (Substrate's shape) must bump it and notify.
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'read_only' WHERE cell_id = $1", [
      id,
    ]);
    // Round-trip a query on the same connection so the async NOTIFY delivery,
    // which piggybacks on the protocol, has certainly been processed.
    await listener.query("SELECT 1");
    listener.release();

    const row = await pool!.query<{ generation: string; updated_at: Date }>(
      "SELECT generation, updated_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    assert.equal(row.rows[0]!.generation, "2");
    assert.deepEqual(notifications, [id]);
  });

  it("always touches updated_at, even on an observed-only write", async () => {
    const tenantId = await newTenant();
    const id = cellId("g");
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    const before1 = await pool!.query<{ updated_at: Date }>(
      "SELECT updated_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pool!.query("UPDATE exomem_cloud_cells SET ready = true WHERE cell_id = $1", [id]);
    const after1 = await pool!.query<{ updated_at: Date; generation: string }>(
      "SELECT updated_at, generation FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    assert.ok(after1.rows[0]!.updated_at.getTime() > before1.rows[0]!.updated_at.getTime());
    assert.equal(after1.rows[0]!.generation, "1");
  });

  // Security review finding 16: the trigger now also fires BEFORE INSERT,
  // unconditionally -- a brand new cell row is itself a desired state the
  // controller has never observed, so cellctl must be woken for it exactly
  // like any other desired-column change, without waiting for a
  // following UPDATE. No generation bump on INSERT: the column's own
  // DEFAULT 1 is already correct.
  it("notifies on INSERT too, leaving generation at its default of 1", async () => {
    const tenantId = await newTenant();
    const id = cellId("i");
    const listener = await pool!.connect();
    const notifications: string[] = [];
    listener.on("notification", (message) => {
      if (message.channel === "exomem_cloud_cells" && message.payload) {
        notifications.push(message.payload);
      }
    });
    await listener.query("LISTEN exomem_cloud_cells");

    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'stopped')",
      [id, tenantId]
    );
    await listener.query("SELECT 1");
    listener.release();

    assert.deepEqual(notifications, [id]);
    const row = await pool!.query<{ generation: string }>(
      "SELECT generation FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    assert.equal(row.rows[0]!.generation, "1");
  });

  // Security review finding 16: RESTRICT, not CASCADE -- a tenant row must
  // never disappear out from under any still-existing Cloud cell row,
  // including one already marked desired_state = 'deleted' (the app never
  // hard-deletes a cell row; the lifecycle sweep only ever soft-deletes it).
  // Only once the row itself is actually gone can the tenant be removed.
  it("refuses to delete a tenant while any Cloud cell row still references it (RESTRICT, not CASCADE)", async () => {
    const tenantId = await newTenant();
    const id = cellId("j");
    await pool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );

    await assert.rejects(
      pool!.query("DELETE FROM exomem_tenants WHERE id = $1", [tenantId]),
      /violates foreign key constraint/
    );

    // A soft-deleted cell row is still a row -- RESTRICT keeps blocking it,
    // unlike the old CASCADE which would have silently taken the cell row
    // (and any of its history) out along with the tenant.
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1", [id]);
    await assert.rejects(
      pool!.query("DELETE FROM exomem_tenants WHERE id = $1", [tenantId]),
      /violates foreign key constraint/
    );

    await pool!.query("DELETE FROM exomem_cloud_cells WHERE cell_id = $1", [id]);
    await pool!.query("DELETE FROM exomem_tenants WHERE id = $1", [tenantId]);
    const remaining = await pool!.query("SELECT id FROM exomem_tenants WHERE id = $1", [tenantId]);
    assert.equal(remaining.rows.length, 0);
  });

  it("holds C1c and C1b as plain writable tables", async () => {
    await pool!.query(
      "INSERT INTO exomem_cloud_capacity (node, cell_slots, attachments_used) VALUES ($1, 4, 1)",
      [`node-${randomUUID()}`]
    );
    await pool!.query(
      "INSERT INTO exomem_cloud_settings (key, value) VALUES ('cell_image', '\"sha256:abc\"'::jsonb)"
    );
    const settings = await pool!.query("SELECT value FROM exomem_cloud_settings WHERE key = 'cell_image'");
    assert.equal(settings.rows[0]!.value, "sha256:abc");
  });
});
