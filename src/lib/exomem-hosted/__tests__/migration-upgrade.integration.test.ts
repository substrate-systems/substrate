import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const MIGRATION_0017 = resolve(process.cwd(), "migrations/0017_exomem_hosted_service.sql");
const MIGRATION_0019 = resolve(process.cwd(), "migrations/0019_exomem_export_lifecycle.sql");

const USER = "11111111-1111-4111-8111-111111111191";
const TENANT = "22222222-2222-4222-8222-222222222291";
const CELL = "33333333-3333-4333-8333-333333333391";
const SOURCE_OPERATION = "44444444-4444-4444-8444-444444444491";
const DELETED_OPERATION = "44444444-4444-4444-8444-444444444492";
const RESTORE_OPERATION = "44444444-4444-4444-8444-444444444493";
const SOURCE_EXPORT = "55555555-5555-4555-8555-555555555591";
const DELETED_EXPORT = "55555555-5555-4555-8555-555555555592";
const SOURCE_DIGEST = Buffer.alloc(32, 0x61);

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

describe("migration 0019 upgrade safety", { skip: !DATABASE_URL }, () => {
  it("upgrades 0017 deleted exports and pins an active legacy restore before GC", async () => {
    await with0017Schema("exomem_upgrade_0019_valid", async (client) => {
      await client.query(
        `INSERT INTO exomem_lifecycle_operations (
           id, tenant_id, cell_id, operation_type, state, checkpoint,
           idempotency_key, fence_generation, completed_at
         ) VALUES
           ($1, $3, $4, 'export', 'succeeded', 'readiness-proved', 'source-export', 1, now()),
           ($2, $3, $4, 'export', 'succeeded', 'readiness-proved', 'deleted-export', 1, now())`,
        [SOURCE_OPERATION, DELETED_OPERATION, TENANT, CELL]
      );
      await client.query(
        `INSERT INTO exomem_lifecycle_operations (
           id, tenant_id, operation_type, state, checkpoint, idempotency_key,
           fence_generation, input_reference_ciphertext, input_reference_digest,
           input_source_cell_id, input_archive_sha256, input_manifest_sha256, input_archive_size
         ) VALUES ($1, $2, 'restore', 'waiting', 'created', 'legacy-restore', 1,
                   '{"encrypted":true}', $3, $4, $5, $6, 1024)`,
        [RESTORE_OPERATION, TENANT, SOURCE_DIGEST, CELL, "a".repeat(64), "b".repeat(64)]
      );
      await client.query(
        `INSERT INTO exomem_exports (
           id, tenant_id, cell_id, operation_id,
           storage_reference_ciphertext, storage_reference_digest,
           archive_sha256, manifest_sha256, archive_size,
           encryption_scheme, integrity_verified, expires_at, state, deleted_at
         ) VALUES
           ($1, $3, $4, $5, '{"encrypted":true}', $6, $7, $8, 1024,
            'envelope-aes-256-gcm', true, now() - interval '1 hour', 'available', NULL),
           ($2, $3, $4, $9, '{"encrypted":true}', $10, $11, $12, 2048,
            'envelope-aes-256-gcm', true, now() - interval '2 hours', 'deleted', now() - interval '1 hour')`,
        [
          SOURCE_EXPORT,
          DELETED_EXPORT,
          TENANT,
          CELL,
          SOURCE_OPERATION,
          SOURCE_DIGEST,
          "a".repeat(64),
          "b".repeat(64),
          DELETED_OPERATION,
          Buffer.alloc(32, 0x62),
          "c".repeat(64),
          "d".repeat(64),
        ]
      );

      await applyMigration(client, MIGRATION_0019);

      const restored = await client.query<{ input_export_id: string | null }>(
        "SELECT input_export_id FROM exomem_lifecycle_operations WHERE id = $1",
        [RESTORE_OPERATION]
      );
      assert.equal(restored.rows[0]?.input_export_id, SOURCE_EXPORT);

      const tombstone = await client.query<{
        storage_reference_ciphertext: unknown;
        storage_reference_digest: Buffer | null;
        archive_sha256: string | null;
        manifest_sha256: string | null;
        archive_size: string | null;
        encryption_scheme: string | null;
        integrity_verified: boolean | null;
        deleted_at: Date;
        provider_deleted_at: Date;
      }>(
        `SELECT storage_reference_ciphertext, storage_reference_digest,
                archive_sha256, manifest_sha256, archive_size,
                encryption_scheme, integrity_verified, deleted_at, provider_deleted_at
         FROM exomem_exports WHERE id = $1`,
        [DELETED_EXPORT]
      );
      assert.deepEqual(
        {
          ciphertext: tombstone.rows[0]?.storage_reference_ciphertext,
          digest: tombstone.rows[0]?.storage_reference_digest,
          archive: tombstone.rows[0]?.archive_sha256,
          manifest: tombstone.rows[0]?.manifest_sha256,
          size: tombstone.rows[0]?.archive_size,
          encryption: tombstone.rows[0]?.encryption_scheme,
          verified: tombstone.rows[0]?.integrity_verified,
        },
        {
          ciphertext: null,
          digest: null,
          archive: null,
          manifest: null,
          size: null,
          encryption: null,
          verified: null,
        }
      );
      assert.equal(
        tombstone.rows[0]?.provider_deleted_at.getTime(),
        tombstone.rows[0]?.deleted_at.getTime()
      );

      const gcCandidates = await client.query<{ id: string }>(
        `SELECT export_row.id
         FROM exomem_exports AS export_row
         JOIN exomem_tenants AS tenant ON tenant.id = export_row.tenant_id
         WHERE tenant.desired_state <> 'deleted'
           AND export_row.state = 'available'
           AND export_row.expires_at <= now()
           AND NOT EXISTS (
             SELECT 1
             FROM exomem_lifecycle_operations AS restore
             WHERE restore.input_export_id = export_row.id
               AND restore.operation_type = 'restore'
               AND restore.state IN ('pending', 'running', 'waiting', 'failed_retryable')
           )`
      );
      assert.deepEqual(gcCandidates.rows, []);
    });
  });

  it("refuses to enable GC when an active legacy restore source cannot be pinned", async () => {
    await with0017Schema("exomem_upgrade_0019_missing", async (client) => {
      await client.query(
        `INSERT INTO exomem_lifecycle_operations (
           id, tenant_id, operation_type, state, checkpoint, idempotency_key,
           fence_generation, input_reference_ciphertext, input_reference_digest,
           input_source_cell_id, input_archive_sha256, input_manifest_sha256, input_archive_size
         ) VALUES ($1, $2, 'restore', 'waiting', 'created', 'missing-source', 1,
                   '{"encrypted":true}', $3, $4, $5, $6, 1024)`,
        [RESTORE_OPERATION, TENANT, Buffer.alloc(32, 0x7f), CELL, "e".repeat(64), "f".repeat(64)]
      );

      await assert.rejects(
        applyMigration(client, MIGRATION_0019),
        /exomem_lifecycle_active_restore_export_pin_check/i
      );
    });
  });
});
