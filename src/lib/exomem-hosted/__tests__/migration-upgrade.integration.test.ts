import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { getLiveExomemAgentContract } from "../agent-contract-store";
import { __setExomemSqlForTests } from "../db";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;
const MIGRATION_0017 = resolve(process.cwd(), "migrations/0017_exomem_hosted_service.sql");
const MIGRATION_0019 = resolve(process.cwd(), "migrations/0019_exomem_export_lifecycle.sql");
const MIGRATION_0020 = resolve(process.cwd(), "migrations/0020_exomem_paddle_reconciliation.sql");
const MIGRATION_0021 = resolve(
  process.cwd(),
  "migrations/0021_exomem_paddle_provider_provenance.sql"
);
const MIGRATION_0022 = resolve(process.cwd(), "migrations/0022_exomem_export_request_intent.sql");
const MIGRATION_0028 = resolve(
  process.cwd(),
  "migrations/0028_exomem_agent_contract_artifacts.sql"
);
const MIGRATION_0033 = resolve(
  process.cwd(),
  "migrations/0033_exomem_mcp_protocol_compatibility.sql"
);
const MIGRATION_0025 = resolve(process.cwd(), "migrations/0025_exomem_mcp_oauth.sql");
const MIGRATION_0032 = resolve(
  process.cwd(),
  "migrations/0032_exomem_client_artifact_identity.sql"
);
const MIGRATION_0034 = resolve(process.cwd(), "migrations/0034_exomem_oauth_client_admission.sql");
const MIGRATION_0035 = resolve(
  process.cwd(),
  "migrations/0035_exomem_marketplace_reviewer_access.sql"
);
const MIGRATION_0036 = resolve(process.cwd(), "migrations/0036_exomem_agent_contract_canaries.sql");
const MIGRATION_0037 = resolve(
  process.cwd(),
  "migrations/0037_exomem_provisioner_v2_runtime_identity.sql"
);

const USER = "11111111-1111-4111-8111-111111111191";
const TENANT = "22222222-2222-4222-8222-222222222291";
const CELL = "33333333-3333-4333-8333-333333333391";
const SOURCE_OPERATION = "44444444-4444-4444-8444-444444444491";
const DELETED_OPERATION = "44444444-4444-4444-8444-444444444492";
const RESTORE_OPERATION = "44444444-4444-4444-8444-444444444493";
const SOURCE_EXPORT = "55555555-5555-4555-8555-555555555591";
const DELETED_EXPORT = "55555555-5555-4555-8555-555555555592";
const SOURCE_DIGEST = Buffer.alloc(32, 0x61);
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

describe("migration 0022 export request intent", { skip: !DATABASE_URL }, () => {
  it("preserves ambiguous legacy export rows and enforces scoped durable intent", async () => {
    await with0017Schema("exomem_upgrade_0022_export_intent", async (client) => {
      await client.query(
        `INSERT INTO exomem_lifecycle_operations (
           id, tenant_id, cell_id, operation_type, state, idempotency_key,
           fence_generation, checkpoint
         ) VALUES ($1, $2, $3, 'export', 'waiting', 'legacy-export', 1, 'quiesced')`,
        [SOURCE_OPERATION, TENANT, CELL]
      );

      await applyMigration(client, MIGRATION_0022);

      const legacy = await client.query<{
        export_expires_at: Date | null;
        export_request_started: boolean;
      }>(
        `SELECT export_expires_at, export_request_started
           FROM exomem_lifecycle_operations
          WHERE id = $1`,
        [SOURCE_OPERATION]
      );
      assert.deepEqual(legacy.rows[0], {
        export_expires_at: null,
        export_request_started: false,
      });

      await client.query(
        `UPDATE exomem_lifecycle_operations
            SET export_expires_at = now() + interval '1 day',
                export_request_started = true
          WHERE id = $1`,
        [SOURCE_OPERATION]
      );
      await assert.rejects(
        client.query(
          `INSERT INTO exomem_lifecycle_operations (
             tenant_id, operation_type, idempotency_key, fence_generation,
             export_expires_at, export_request_started
           ) VALUES ($1, 'resume', 'invalid-export-intent', 1, now(), true)`,
          [TENANT]
        ),
        /exomem_lifecycle_export_request_intent_check/i
      );
    });
  });
});

describe("migration 0033 MCP protocol compatibility", { skip: !DATABASE_URL }, () => {
  it("backfills the pinned protocol identity for a pre-0033 live contract and rejects invalid values", async () => {
    await with0017Schema("exomem_upgrade_0033_mcp_protocols", async (client) => {
      await applyMigration(client, MIGRATION_0028);
      await client.query(
        `INSERT INTO exomem_agent_contract_candidates (
           state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
           compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
           promoted_at
         ) VALUES (
           'live', 'hosted-alpha-agent-v1', 'https://substratesystems.io/api/exomem/mcp/v1',
           '0.33.0', $1, $2, $3, '1', '{}', '{}', '{}', now()
         )`,
        ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
      );

      await applyMigration(client, MIGRATION_0033);

      const legacyLive = await client.query<{
        state: string;
        mcp_protocol_versions: string[];
      }>(
        `SELECT state, mcp_protocol_versions
           FROM exomem_agent_contract_candidates
          WHERE profile_id = 'hosted-alpha-agent-v1' AND state = 'live'`
      );
      assert.deepEqual(legacyLive.rows, [
        { state: "live", mcp_protocol_versions: ["2025-11-25", "2025-06-18"] },
      ]);
      __setExomemSqlForTests(async (strings, ...values) => {
        let text = strings[0];
        for (let index = 0; index < values.length; index += 1)
          text += `$${index + 1}${strings[index + 1]}`;
        const result = await client.query(text, values);
        return {
          rows: result.rows as Array<Record<string, unknown>>,
          rowCount: result.rowCount ?? 0,
        };
      });
      try {
        assert.deepEqual((await getLiveExomemAgentContract())?.mcpProtocolVersions, [
          "2025-11-25",
          "2025-06-18",
        ]);
      } finally {
        __setExomemSqlForTests(null);
      }

      for (const value of [[null], [42], ["2025-11-25", "2025-11-25"], ["not-a-date"]]) {
        await assert.rejects(
          client.query(
            `UPDATE exomem_agent_contract_candidates
                SET mcp_protocol_versions = $1::jsonb
              WHERE profile_id = 'hosted-alpha-agent-v1'`,
            [JSON.stringify(value)]
          ),
          /exomem_agent_contract_candidates_mcp_protocol_versions_check/i
        );
      }
    });
  });
});

describe("migration 0036 canary upgrade safety", { skip: !DATABASE_URL }, () => {
  it("preserves 0035 reviewer-purpose tenants without creating rollout or staged authority", async () => {
    await with0017Schema("exomem_upgrade_0036_canaries", async (client) => {
      await applyMigration(client, MIGRATION_0025);
      await applyMigration(client, MIGRATION_0028);
      await applyMigration(client, MIGRATION_0032);
      await applyMigration(client, MIGRATION_0033);
      await applyMigration(client, MIGRATION_0034);
      const migrationsDir = mkdtempSync(resolve(tmpdir(), "exomem-0036-upgrade-"));
      const scoped = new URL(DATABASE_URL!);
      scoped.searchParams.set("options", "-c search_path=exomem_upgrade_0036_canaries,public");
      let reviewerTenantId: string | undefined;
      try {
        copyFileSync(
          MIGRATION_0035,
          resolve(migrationsDir, "0035_exomem_marketplace_reviewer_access.sql")
        );
        await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });
        const reviewer = await client.query<{ id: string }>(
          "INSERT INTO users (id, email) VALUES ($1, 'reviewer-upgrade@example.com') RETURNING id",
          [USER_TWO]
        );
        const tenant = await client.query<{ id: string }>(
          `INSERT INTO exomem_tenants (
             owner_user_id, status, desired_state, marketplace_reviewer_purpose
           ) VALUES ($1, 'active', 'running', true) RETURNING id`,
          [reviewer.rows[0]!.id]
        );
        reviewerTenantId = tenant.rows[0]!.id;
        copyFileSync(
          MIGRATION_0036,
          resolve(migrationsDir, "0036_exomem_agent_contract_canaries.sql")
        );
        await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });
      } finally {
        rmSync(migrationsDir, { recursive: true, force: true });
      }

      assert.deepEqual(
        (
          await client.query<{
            marketplace_reviewer_purpose: boolean;
            assignments: string;
            declarations: string;
          }>(
            `SELECT tenant.marketplace_reviewer_purpose,
                    (SELECT count(*) FROM exomem_agent_contract_rollout_assignments)::text AS assignments,
                    (SELECT count(*) FROM exomem_staged_client_releases)::text AS declarations
             FROM exomem_tenants AS tenant WHERE tenant.id = $1`,
            [reviewerTenantId]
          )
        ).rows,
        [{ marketplace_reviewer_purpose: true, assignments: "0", declarations: "0" }]
      );
    });
  });
});

describe("migration 0037 provisioner wire protocol upgrade safety", { skip: !DATABASE_URL }, () => {
  it("backfills v1, preserves legacy inserts, and constrains immutable v2 target identity", async () => {
    await with0017Schema("exomem_upgrade_0037_wire_protocol", async (client) => {
      await applyMigration(client, MIGRATION_0025);
      await applyMigration(client, MIGRATION_0028);
      await applyMigration(client, MIGRATION_0032);
      await applyMigration(client, MIGRATION_0033);
      await applyMigration(client, MIGRATION_0034);

      const migrationsDir = mkdtempSync(resolve(tmpdir(), "exomem-0037-upgrade-"));
      const scoped = new URL(DATABASE_URL!);
      scoped.searchParams.set("options", "-c search_path=exomem_upgrade_0037_wire_protocol,public");
      try {
        copyFileSync(
          MIGRATION_0035,
          resolve(migrationsDir, "0035_exomem_marketplace_reviewer_access.sql")
        );
        copyFileSync(
          MIGRATION_0036,
          resolve(migrationsDir, "0036_exomem_agent_contract_canaries.sql")
        );
        await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });

        await client.query(
          `INSERT INTO exomem_lifecycle_operations (
             id, tenant_id, cell_id, operation_type, state, checkpoint, idempotency_key, fence_generation
           ) VALUES ($1, $2, $3, 'seal', 'waiting', 'created', 'legacy-before-0037', 1)`,
          [SOURCE_OPERATION, TENANT, CELL]
        );
        const before = await client.query<{
          cells: string;
          candidates: string;
          assignments: string;
        }>(
          `SELECT
             (SELECT count(*) FROM exomem_cells)::text AS cells,
             (SELECT count(*) FROM exomem_agent_contract_candidates)::text AS candidates,
             (SELECT count(*) FROM exomem_agent_contract_rollout_assignments)::text AS assignments`
        );

        copyFileSync(
          MIGRATION_0037,
          resolve(migrationsDir, "0037_exomem_provisioner_v2_runtime_identity.sql")
        );
        await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir });

        assert.equal(
          (
            await client.query<{ provisioner_wire_protocol: string }>(
              "SELECT provisioner_wire_protocol FROM exomem_lifecycle_operations WHERE id = $1",
              [SOURCE_OPERATION]
            )
          ).rows[0]?.provisioner_wire_protocol,
          "exomem-cell-provisioner.v1"
        );
        assert.deepEqual(
          (
            await client.query<{ cells: string; candidates: string; assignments: string }>(
              `SELECT
                 (SELECT count(*) FROM exomem_cells)::text AS cells,
                 (SELECT count(*) FROM exomem_agent_contract_candidates)::text AS candidates,
                 (SELECT count(*) FROM exomem_agent_contract_rollout_assignments)::text AS assignments`
            )
          ).rows,
          before.rows
        );
        const claimedLegacy = await client.query<{
          state: string;
          checkpoint: string;
          lease_owner: string;
        }>(
          `UPDATE exomem_lifecycle_operations
              SET state = 'running',
                  checkpoint = 'resolving_target',
                  lease_owner = 'legacy-worker',
                  lease_expires_at = now() + interval '1 minute'
            WHERE id = $1
          RETURNING state, checkpoint, lease_owner`,
          [SOURCE_OPERATION]
        );
        assert.deepEqual(claimedLegacy.rows, [
          { state: 'running', checkpoint: 'resolving_target', lease_owner: 'legacy-worker' },
        ]);
        const checkpointedLegacy = await client.query<{ checkpoint: string }>(
          `UPDATE exomem_lifecycle_operations
              SET checkpoint = 'awaiting_provider'
            WHERE id = $1
              AND state = 'running'
              AND lease_owner = 'legacy-worker'
          RETURNING checkpoint`,
          [SOURCE_OPERATION]
        );
        assert.deepEqual(checkpointedLegacy.rows, [{ checkpoint: 'awaiting_provider' }]);

        await client.query(
          `INSERT INTO exomem_lifecycle_operations (
             tenant_id, operation_type, idempotency_key, fence_generation
           ) VALUES ($1, 'delete', 'legacy-omits-wire-protocol', 1)`,
          [TENANT]
        );
        assert.equal(
          (
            await client.query<{ provisioner_wire_protocol: string }>(
              `SELECT provisioner_wire_protocol
                 FROM exomem_lifecycle_operations
                WHERE tenant_id = $1 AND idempotency_key = 'legacy-omits-wire-protocol'`,
              [TENANT]
            )
          ).rows[0]?.provisioner_wire_protocol,
          "exomem-cell-provisioner.v1"
        );

        await assert.rejects(
          client.query(
            `INSERT INTO exomem_lifecycle_operations (
               tenant_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol
             ) VALUES ($1, 'delete', 'invalid-wire-protocol', 1, 'exomem-cell-provisioner.v3')`,
            [TENANT]
          ),
          /exomem_lifecycle_provisioner_wire_protocol_check/i
        );
        await assert.rejects(
          client.query(
            `INSERT INTO exomem_lifecycle_operations (
               tenant_id, cell_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol
             ) VALUES ($1, $2, 'seal', 'v2-missing-target', 1, 'exomem-cell-provisioner.v2')`,
            [TENANT, CELL]
          ),
          /lifecycle target is required for new operation|exomem_lifecycle_v2_target_check/i
        );
        await assert.rejects(
          client.query(
            `INSERT INTO exomem_lifecycle_operations (
               tenant_id, cell_id, operation_type, idempotency_key, fence_generation
             ) VALUES ($1, $2, 'seal', 'v1-missing-target', 1)`,
            [TENANT, CELL]
          ),
          /lifecycle target is required for new operation/i
        );
        await client.query(
          `INSERT INTO exomem_lifecycle_operations (
             tenant_id, operation_type, idempotency_key, fence_generation, provisioner_wire_protocol
           ) VALUES ($1, 'delete', 'v2-no-cell-delete', 1, 'exomem-cell-provisioner.v2')`,
          [TENANT]
        );
        await assert.rejects(
          client.query(
            `INSERT INTO exomem_lifecycle_operations (
               tenant_id, expected_previous_cell_id, operation_type, idempotency_key,
               fence_generation, provisioner_wire_protocol
             ) VALUES ($1, $2, 'delete', 'v2-retained-cell-delete', 1, 'exomem-cell-provisioner.v2')`,
            [TENANT, CELL]
          ),
          /lifecycle target is required for new operation|exomem_lifecycle_v2_target_check/i
        );

        const candidate = await client.query<{ id: string }>(
          `INSERT INTO exomem_agent_contract_candidates (
             state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
             compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
             promoted_at
           ) VALUES (
             'live', 'hosted-alpha-agent-v1', 'https://agent.example.test', '2026.07.30',
             $1, $2, $3, '1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now()
           ) RETURNING id`,
          ["a".repeat(64), "b".repeat(64), "c".repeat(64)]
        );
        await client.query(
          `INSERT INTO exomem_lifecycle_operations (
             tenant_id, cell_id, operation_type, idempotency_key, fence_generation,
             provisioner_wire_protocol, target_candidate_id, target_source_release,
             target_protocol_version, target_gateway_contract_digest, target_command_fingerprint,
             target_schema_digest, target_compatibility_digest
           ) VALUES ($1, $2, 'seal', 'v2-complete-target', 1, 'exomem-cell-provisioner.v2',
                     $3, '2026.07.30', '1', $4, $5, $6, $7)`,
          [
            TENANT,
            CELL,
            candidate.rows[0]!.id,
            "d".repeat(64),
            "a".repeat(64),
            "b".repeat(64),
            "c".repeat(64),
          ]
        );
        await assert.rejects(
          client.query(
            `INSERT INTO exomem_lifecycle_operations (
               tenant_id, operation_type, idempotency_key, fence_generation,
               provisioner_wire_protocol, target_candidate_id, target_source_release,
               target_protocol_version, target_gateway_contract_digest, target_command_fingerprint,
               target_schema_digest, target_compatibility_digest
             ) VALUES ($1, 'delete', 'v2-no-cell-target', 1, 'exomem-cell-provisioner.v2',
                       $2, '2026.07.30', '1', $3, $4, $5, $6)`,
            [
              TENANT,
              candidate.rows[0]!.id,
              "d".repeat(64),
              "a".repeat(64),
              "b".repeat(64),
              "c".repeat(64),
            ]
          ),
          /exomem_lifecycle_v2_target_check/i
        );
        await assert.rejects(
          client.query(
            `UPDATE exomem_lifecycle_operations
                SET target_candidate_id = $1,
                    target_source_release = '2026.07.30',
                    target_protocol_version = '1',
                    target_gateway_contract_digest = $2,
                    target_command_fingerprint = $3,
                    target_schema_digest = $4,
                    target_compatibility_digest = $5
              WHERE tenant_id = $6 AND idempotency_key = 'v2-no-cell-delete'`,
            [
              candidate.rows[0]!.id,
              "d".repeat(64),
              "a".repeat(64),
              "b".repeat(64),
              "c".repeat(64),
              TENANT,
            ]
          ),
          /v2 lifecycle identity is immutable/i
        );
        await assert.rejects(
          client.query(
            `UPDATE exomem_lifecycle_operations
                SET idempotency_key = 'mutated-v2-idempotency-key'
              WHERE tenant_id = $1 AND idempotency_key = 'v2-complete-target'`,
            [TENANT]
          ),
          /v2 lifecycle identity is immutable/i
        );
        await client.query(
          `UPDATE exomem_lifecycle_operations
              SET checkpoint = 'resolving_target',
                  updated_at = now()
            WHERE tenant_id = $1 AND idempotency_key = 'v2-complete-target'`,
          [TENANT]
        );
        await assert.rejects(
          client.query(
            "UPDATE exomem_lifecycle_operations SET provisioner_wire_protocol = 'exomem-cell-provisioner.v2' WHERE id = $1",
            [SOURCE_OPERATION]
          ),
          /provisioner wire protocol is immutable/i
        );
      } finally {
        rmSync(migrationsDir, { recursive: true, force: true });
      }
    });
  });
});
