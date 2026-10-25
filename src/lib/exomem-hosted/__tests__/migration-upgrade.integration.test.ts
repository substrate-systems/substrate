import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";
import { applyMigrations } from "../../../../scripts/migrate";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const MIGRATION_0017 = resolve(process.cwd(), "migrations/0017_exomem_hosted_service.sql");
const MIGRATION_0020 = resolve(process.cwd(), "migrations/0020_exomem_paddle_reconciliation.sql");
const MIGRATION_0021 = resolve(
  process.cwd(),
  "migrations/0021_exomem_paddle_provider_provenance.sql"
);

const USER = "11111111-1111-4111-8111-111111111191";
const TENANT = "22222222-2222-4222-8222-222222222291";
const CELL = "33333333-3333-4333-8333-333333333391";
const USER_TWO = "11111111-1111-4111-8111-111111111192";
const TENANT_TWO = "22222222-2222-4222-8222-222222222292";
const USER_THREE = "11111111-1111-4111-8111-111111111193";
const TENANT_THREE = "22222222-2222-4222-8222-222222222293";

function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment >= 0 ? line.slice(0, comment) : line;
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(client: PoolClient, path: string): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of statements(path)) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function create0017Schema(client: PoolClient, schema: string): Promise<void> {
  await ensureExomemPostgresTestExtensions(DATABASE_URL!);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query("CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE)");
  await applyMigration(client, MIGRATION_0017);
  await client.query("INSERT INTO users (id, email) VALUES ($1, 'owner@example.com')", [USER]);
  await client.query(
    `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
     VALUES ($1, $2, 'active', 'running')`,
    [TENANT, USER]
  );
  await client.query(
    `INSERT INTO exomem_cells (
       id, tenant_id, lifecycle_state, routing_state, desired_state,
       protocol_version, release_version
     ) VALUES ($1, $2, 'active', 'bound', 'running', '1', 'fixture')`,
    [CELL, TENANT]
  );
  await client.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [CELL, TENANT]);
}

async function with0017Schema(
  schema: string,
  callback: (client: PoolClient) => Promise<void>
): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await create0017Schema(client, schema);
    await callback(client);
  } finally {
    await client.query("SET search_path TO public").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

describe("migration 0020 upgrade safety", { skip: !DATABASE_URL }, () => {
  it("makes an existing paid subscription due and enforces valid lease state", async () => {
    await with0017Schema("exomem_upgrade_0020_paid", async (client) => {
      await client.query(
        `INSERT INTO exomem_entitlements (
           tenant_id, source, source_state, effective_state,
           capabilities, resource_limits, provider_subscription_ref
         ) VALUES ($1, 'paddle', 'active', 'active', '[]', '{}', $2)`,
        [TENANT, "sub_existing_paid"]
      );

      await applyMigration(client, MIGRATION_0020);

      const state = await client.query<{
        due: boolean;
        attempts: number;
        lease_owner: string | null;
        lease_expires_at: Date | null;
      }>(
        `SELECT provider_reconcile_after <= now() AS due,
                provider_reconcile_attempts AS attempts,
                provider_reconcile_lease_owner AS lease_owner,
                provider_reconcile_lease_expires_at AS lease_expires_at
           FROM exomem_entitlements
          WHERE tenant_id = $1`,
        [TENANT]
      );
      assert.deepEqual(state.rows[0], {
        due: true,
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
      });

      await assert.rejects(
        client.query(
          `UPDATE exomem_entitlements
              SET provider_reconcile_lease_owner = $1
            WHERE tenant_id = $2`,
          ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", TENANT]
        ),
        /exomem_entitlements_provider_reconcile_lease_check/i
      );
      await assert.rejects(
        client.query(
          `UPDATE exomem_entitlements
              SET provider_reconcile_attempts = -1
            WHERE tenant_id = $1`,
          [TENANT]
        ),
        /exomem_entitlements_provider_reconcile_attempts_check/i
      );
    });
  });
});

describe("migration 0021 Paddle provider provenance", { skip: !DATABASE_URL }, () => {
  it("backfills only receipt-proven environments and qualifies provider-ref uniqueness", async () => {
    await with0017Schema("exomem_upgrade_0021_proven", async (client) => {
      const sharedTransaction = `txn_${"a".repeat(26)}`;
      await client.query(
        `INSERT INTO exomem_entitlements (
           tenant_id, source, source_state, effective_state,
           capabilities, resource_limits, provider_transaction_ref
         ) VALUES ($1, 'paddle', 'checkout_pending', 'provisioning', '[]', '{}', $2)`,
        [TENANT, sharedTransaction]
      );
      await client.query(
        `INSERT INTO exomem_paddle_events (
           paddle_event_id, environment, event_type, tenant_id,
           occurred_at, applied_at, disposition
         ) VALUES ('evt_proven_sandbox', 'sandbox', 'transaction.updated', $1,
                   now(), now(), 'applied')`,
        [TENANT]
      );

      await client.query("INSERT INTO users (id, email) VALUES ($1, 'owner-two@example.com')", [
        USER_TWO,
      ]);
      await client.query(
        `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
         VALUES ($1, $2, 'active', 'running')`,
        [TENANT_TWO, USER_TWO]
      );
      await client.query(
        `INSERT INTO exomem_entitlements (
           tenant_id, source, source_state, effective_state,
           capabilities, resource_limits, provider_transaction_ref
         ) VALUES ($1, 'paddle', 'checkout_pending', 'provisioning', '[]', '{}', $2)`,
        [TENANT_TWO, `txn_${"b".repeat(26)}`]
      );
      await client.query(
        `INSERT INTO exomem_paddle_events (
           paddle_event_id, environment, event_type, tenant_id,
           occurred_at, applied_at, disposition
         ) VALUES ('evt_proven_live', 'live', 'transaction.updated', $1,
                   now(), now(), 'applied')`,
        [TENANT_TWO]
      );

      await applyMigration(client, MIGRATION_0021);

      const environments = await client.query<{
        tenant_id: string;
        provider_environment: string | null;
      }>(
        `SELECT tenant_id, provider_environment
           FROM exomem_entitlements
          WHERE tenant_id IN ($1, $2)
          ORDER BY tenant_id`,
        [TENANT, TENANT_TWO]
      );
      assert.deepEqual(environments.rows, [
        { tenant_id: TENANT, provider_environment: "sandbox" },
        { tenant_id: TENANT_TWO, provider_environment: "production" },
      ]);

      // The same opaque Paddle ID can exist in separate Paddle environments.
      await client.query(
        `UPDATE exomem_entitlements
            SET provider_transaction_ref = $1
          WHERE tenant_id = $2`,
        [sharedTransaction, TENANT_TWO]
      );

      await client.query("INSERT INTO users (id, email) VALUES ($1, 'owner-three@example.com')", [
        USER_THREE,
      ]);
      await client.query(
        `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
         VALUES ($1, $2, 'active', 'running')`,
        [TENANT_THREE, USER_THREE]
      );
      await assert.rejects(
        client.query(
          `INSERT INTO exomem_entitlements (
             tenant_id, source, source_state, effective_state,
             capabilities, resource_limits, provider_environment,
             provider_transaction_ref
           ) VALUES ($1, 'paddle', 'checkout_pending', 'provisioning', '[]', '{}',
                     'sandbox', $2)`,
          [TENANT_THREE, sharedTransaction]
        ),
        /exomem_entitlements_provider_transaction_environment_idx/i
      );
    });
  });

  it("leaves conflicting receipt history unguessed and blocks new ambiguous provider refs", async () => {
    await with0017Schema("exomem_upgrade_0021_ambiguous", async (client) => {
      const legacyTransaction = `txn_${"c".repeat(26)}`;
      await client.query(
        `INSERT INTO exomem_entitlements (
           tenant_id, source, source_state, effective_state,
           capabilities, resource_limits, provider_transaction_ref
         ) VALUES ($1, 'paddle', 'checkout_pending', 'provisioning', '[]', '{}', $2)`,
        [TENANT, legacyTransaction]
      );
      await client.query(
        `INSERT INTO exomem_paddle_events (
           paddle_event_id, environment, event_type, tenant_id,
           occurred_at, applied_at, disposition
         ) VALUES
           ('evt_ambiguous_sandbox', 'sandbox', 'transaction.updated', $1,
            now(), now(), 'applied'),
           ('evt_ambiguous_live', 'live', 'transaction.updated', $1,
            now(), now(), 'applied')`,
        [TENANT]
      );

      // The migration preserves the legacy row for manual resolution instead
      // of inventing provenance or making the whole upgrade impossible.
      await applyMigration(client, MIGRATION_0021);
      const legacy = await client.query<{
        provider_environment: string | null;
        provider_provenance_unresolved_fingerprint: string | null;
      }>(
        `SELECT provider_environment,
                provider_provenance_unresolved_fingerprint
           FROM exomem_entitlements
          WHERE tenant_id = $1`,
        [TENANT]
      );
      assert.equal(legacy.rows[0]?.provider_environment, null);
      assert.ok(legacy.rows[0]?.provider_provenance_unresolved_fingerprint);

      // Unresolved provenance blocks provider calls, not product lifecycle.
      // Deletion confirmation must still be able to close the entitlement.
      await client.query(
        `UPDATE exomem_entitlements
            SET effective_state = 'deleted', capabilities = '[]'::jsonb
          WHERE tenant_id = $1`,
        [TENANT]
      );
      const gated = await client.query<{
        effective_state: string;
        provider_transaction_ref: string;
      }>(
        `SELECT effective_state, provider_transaction_ref
           FROM exomem_entitlements
          WHERE tenant_id = $1`,
        [TENANT]
      );
      assert.deepEqual(gated.rows[0], {
        effective_state: "deleted",
        provider_transaction_ref: legacyTransaction,
      });

      await assert.rejects(
        client.query(
          `UPDATE exomem_entitlements
              SET provider_transaction_ref = $1
            WHERE tenant_id = $2`,
          [`txn_${"d".repeat(26)}`, TENANT]
        ),
        /exomem_entitlements_provider_reference_provenance_check/i
      );

      await client.query("INSERT INTO users (id, email) VALUES ($1, 'owner-three@example.com')", [
        USER_THREE,
      ]);
      await client.query(
        `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state)
         VALUES ($1, $2, 'active', 'running')`,
        [TENANT_THREE, USER_THREE]
      );
      await assert.rejects(
        client.query(
          `INSERT INTO exomem_entitlements (
             tenant_id, source, source_state, effective_state,
             capabilities, resource_limits, provider_transaction_ref
           ) VALUES ($1, 'paddle', 'checkout_pending', 'provisioning', '[]', '{}', $2)`,
          [TENANT_THREE, `txn_${"e".repeat(26)}`]
        ),
        /exomem_entitlements_provider_reference_provenance_check/i
      );
    });
  });
});

describe("migration 0074 independent Exomem identity", { skip: !DATABASE_URL }, () => {
  it("backfills identity history, scrubs deleted accounts, and refuses an owner that exists only in shared users", async () => {
    const schema = `exomem_identity_${randomUUID().replaceAll("-", "")}`;
    const migrationsDir = mkdtempSync(join(tmpdir(), "exomem-identity-migrations-"));
    const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
    let pool: Pool | undefined;
    try {
      await ensureExomemPostgresTestExtensions(DATABASE_URL!);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(DATABASE_URL!);
      scoped.searchParams.set("options", `-c search_path=${schema},public`);
      for (const filename of readdirSync(resolve("migrations"))) {
        if (filename.endsWith(".sql") && filename < "0074_") {
          copyFileSync(resolve("migrations", filename), join(migrationsDir, filename));
        }
      }
      await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });
      pool = new Pool({ connectionString: scoped.toString(), max: 1 });
      const ownerId = randomUUID();
      const historyId = randomUUID();
      const unrelatedId = randomUUID();
      const tenantId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, email_verified_at, created_at, deleted_at) VALUES
         ($1, 'deleted-owner@example.test', now() - interval '2 days', now() - interval '3 days', NULL),
         ($2, 'historical-owner@example.test', NULL, now() - interval '2 days', NULL),
         ($3, 'other-product@example.test', NULL, now() - interval '1 day', NULL)`,
        [ownerId, historyId, unrelatedId]
      );
      await pool.query(
        `INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state, deleted_at)
         VALUES ($1, $2, 'deleted', 'deleted', now())`,
        [tenantId, ownerId]
      );
      await pool.query(
        `INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, now() - interval '2 days', now() - interval '1 day', now())`,
        [historyId, tenantId, randomBytes(32), randomBytes(32)]
      );
      const deletedTenant = await pool.query(
        "SELECT deleted_at FROM exomem_tenants WHERE id = $1",
        [tenantId]
      );
      const sharedBefore = await pool.query("SELECT * FROM users ORDER BY id");
      const sessionsBefore = await pool.query("SELECT * FROM exomem_sessions");
      const identityForeignKeys = () =>
        pool!.query(
          `SELECT constraint_row.conrelid::regclass::text AS table_name, constraint_row.conname
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
         WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'users'::regclass
           AND relation.relnamespace = current_schema()::regnamespace
           AND starts_with(relation.relname, 'exomem_')
         ORDER BY table_name, constraint_row.conname`
        );
      const foreignKeysBefore = await identityForeignKeys();
      assert.equal(foreignKeysBefore.rowCount, 8);

      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exomem_gateway') THEN
          CREATE ROLE exomem_gateway NOLOGIN;
        END IF;
      END $$`);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO exomem_gateway`);
      await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });
      copyFileSync(
        resolve("migrations/0074_exomem_users.sql"),
        join(migrationsDir, "0074_exomem_users.sql")
      );
      await applyMigrations({
        databaseUrl: scoped.toString(),
        migrationsDir,
        grantsFile: join(migrationsDir, "grants-not-yet-applied.sql"),
      });
      await pool.query("SET ROLE exomem_gateway");
      try {
        const eligible = await pool.query(
          "SELECT exomem_cloud_reviewer_tenant_eligible($1, $2) AS eligible",
          [tenantId, ownerId]
        );
        assert.equal(eligible.rows[0]!.eligible, false);
      } finally {
        await pool.query("RESET ROLE");
      }
      copyFileSync(
        resolve("migrations/0075_exomem_theme_choice.sql"),
        join(migrationsDir, "0075_exomem_theme_choice.sql")
      );
      await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });

      assert.deepEqual(
        (await pool.query("SELECT * FROM users ORDER BY id")).rows,
        sharedBefore.rows
      );
      assert.deepEqual(
        (await pool.query("SELECT * FROM exomem_users ORDER BY id")).rows,
        sharedBefore.rows
          .filter((row) => row.id !== unrelatedId)
          .map((row) =>
            row.id === ownerId
              ? {
                  ...row,
                  email: null,
                  email_verified_at: null,
                  deleted_at: deletedTenant.rows[0]!.deleted_at,
                }
              : row
          )
      );
      assert.deepEqual(
        (await pool.query("SELECT * FROM exomem_sessions")).rows,
        sessionsBefore.rows
      );
      assert.deepEqual((await identityForeignKeys()).rows, foreignKeysBefore.rows);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'exomem_users'::regclass AND contype = 'f'"
          )
        ).rows[0]!.n,
        0
      );

      await assert.rejects(pool.query("INSERT INTO exomem_users (email) VALUES (NULL)"), {
        code: "23514",
      });
      await assert.rejects(
        pool.query("UPDATE exomem_users SET email = 'retained@example.test' WHERE id = $1", [
          ownerId,
        ]),
        { code: "23514" }
      );

      await applyMigrations({ databaseUrl: scoped.toString() });
      assert.equal((await identityForeignKeys()).rowCount, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = 'exomem_users'::regclass AND connamespace = current_schema()::regnamespace"
          )
        ).rows[0]!.n,
        8
      );
      assert.deepEqual(
        (await pool.query("SELECT * FROM exomem_sessions")).rows,
        sessionsBefore.rows
      );
      const independent = (
        await pool.query(
          "INSERT INTO exomem_users (email) VALUES ('independent@example.test') RETURNING id"
        )
      ).rows[0]!.id;
      await pool.query("INSERT INTO exomem_tenants (owner_user_id) VALUES ($1)", [independent]);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM users WHERE id = $1", [independent]))
          .rows[0]!.n,
        0
      );
      // Nothing copies a shared users row into exomem_users any more.
      const sharedOnly = (
        await pool.query("INSERT INTO users (email) VALUES ('shared-only@example.test') RETURNING id")
      ).rows[0]!.id;
      await assert.rejects(
        pool.query("INSERT INTO exomem_tenants (owner_user_id) VALUES ($1)", [sharedOnly]),
        { code: "23503" }
      );
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(migrationsDir, { recursive: true, force: true });
    }
  });
});
