import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId, redeemCloudInviteAtomic } from "../cloud-admission";
import { handleCloudExportLinkRequest, handleCloudExportsRequest } from "../cloud-exports";
import { handleCloudHomeLevelsRequest } from "../cloud-home-mcp";
import { reconcileCloudCellDesiredState } from "../cloud-lifecycle";
import { findCloudOAuthAccessToken, recordCloudAppUse } from "../cloud-oauth";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { digestSecret, generateExternalToken } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// D7 (reopened task 3.2): scripts/exomem-cloud-grants.sql is the single
// implementation of both (1) schema-wide substrate_app DML plus default
// privileges for later migrations, and (2) the C1 privilege table -- exactly
// on C1-C1d, which the script revokes substrate_app's schema-wide grant on
// before applying. This suite proves it against real roles and a real
// database, not a superuser connection that cannot see a missing grant:
// substrate_owner owns the schema and runs the migrations (as production
// does through DATABASE_MIGRATION_URL); substrate_app, exomem_cellctl and
// exomem_gateway are plain login roles with no other privilege.

// The export link's per-account rate limit keys its bucket with this key.
process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const TEST_PASSWORD = "exomem-cloud-grants-test";
const CLOUD_ROLES = ["substrate_app", "exomem_cellctl", "exomem_gateway"] as const;
const C1_TABLES = [
  "exomem_cloud_cells",
  "exomem_cloud_settings",
  "exomem_cloud_capacity",
  "exomem_cloud_rollout",
] as const;
const CLOUD_RESOURCE = "https://cloud.example.test/mcp/v1";

let adminPool: Pool | undefined;
let ownerPool: Pool | undefined;
let appPool: Pool | undefined;
let cellctlPool: Pool | undefined;
let gatewayPool: Pool | undefined;
let schema: string | undefined;

function cellId(fill: string): string {
  return fill.repeat(16).slice(0, 16);
}

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

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = TEST_PASSWORD;
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function ensureRole(name: string): Promise<void> {
  await adminPool!.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
         CREATE ROLE ${name} LOGIN PASSWORD '${TEST_PASSWORD}';
       ELSE
         ALTER ROLE ${name} WITH LOGIN PASSWORD '${TEST_PASSWORD}';
       END IF;
     END
     $$;`
  );
}

/** `has_table_privilege`/`has_sequence_privilege` resolve unqualified names
 * through the CALLING connection's own search_path, so every catalog query
 * below runs on `ownerPool`, which already carries `-c search_path=<schema>,public`. */
async function tablePrivileges(
  role: string,
  tableNames: readonly string[]
): Promise<Record<string, { select: boolean; insert: boolean; update: boolean; delete: boolean }>> {
  const result: Record<string, { select: boolean; insert: boolean; update: boolean; delete: boolean }> = {};
  for (const name of tableNames) {
    const { rows } = await ownerPool!.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT has_table_privilege($1, quote_ident($2), 'SELECT') AS can_select,
              has_table_privilege($1, quote_ident($2), 'INSERT') AS can_insert,
              has_table_privilege($1, quote_ident($2), 'UPDATE') AS can_update,
              has_table_privilege($1, quote_ident($2), 'DELETE') AS can_delete`,
      [role, name]
    );
    result[name] = {
      select: rows[0]!.can_select,
      insert: rows[0]!.can_insert,
      update: rows[0]!.can_update,
      delete: rows[0]!.can_delete,
    };
  }
  return result;
}

async function publicTableNames(): Promise<string[]> {
  const { rows } = await ownerPool!.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  return rows.map((row) => row.table_name);
}

/** Every relation and column ACL in the schema, for the "second run changes
 * nothing" proof -- relacl/attacl, not a narrower per-table has_privilege
 * spot check, so nothing this script grants can drift unnoticed. */
async function aclSnapshot(): Promise<{ relacl: unknown[]; attacl: unknown[] }> {
  const relacl = await adminPool!.query(
    `SELECT c.relname, c.relacl
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'S')
     ORDER BY c.relname`,
    [schema]
  );
  const attacl = await adminPool!.query(
    `SELECT c.relname, a.attname, a.attacl
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND a.attacl IS NOT NULL AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attname`,
    [schema]
  );
  return { relacl: relacl.rows, attacl: attacl.rows };
}

async function newTenant(reviewerPurpose = false): Promise<string> {
  const email = `cloud-grants-${randomUUID()}@example.test`;
  const user = await ownerPool!.query<{ id: string }>(
    "INSERT INTO exomem_users (email) VALUES ($1) RETURNING id",
    [email]
  );
  const tenant = await ownerPool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id, marketplace_reviewer_purpose) VALUES ($1, $2) RETURNING id",
    [user.rows[0]!.id, reviewerPurpose]
  );
  return tenant.rows[0]!.id;
}

describe("Exomem Cloud grants PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `cloud_grants_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    adminPool = new Pool({ connectionString: databaseUrl });

    // substrate_owner must exist and own the schema before any migration
    // runs -- it is the schema-creating, migration-running role in
    // production (DATABASE_MIGRATION_URL), not a superuser standing in for
    // it.
    await ensureRole("substrate_owner");
    await adminPool.query(`CREATE SCHEMA "${schema}" AUTHORIZATION substrate_owner`);
    const ownerUrl = roleUrl(databaseUrl!, "substrate_owner");

    // First run: substrate_app/exomem_cellctl/exomem_gateway do not exist
    // yet -- applyGrants's every role-existence guard is false, so this
    // creates and owns the whole schema of record with no grants applied,
    // exactly the state a fresh install reaches before those roles are
    // provisioned.
    await applyMigrations({ databaseUrl: ownerUrl });

    for (const role of CLOUD_ROLES) await ensureRole(role);
    await adminPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${CLOUD_ROLES.join(", ")}`);

    // Second run: zero pending migrations (the "up to date" path), applies
    // the grants for real -- exercising exactly the ordering the migration
    // runner promises: "applied ... when the roles exist".
    await applyMigrations({ databaseUrl: ownerUrl });

    ownerPool = new Pool({ connectionString: ownerUrl });
    appPool = new Pool({ connectionString: roleUrl(databaseUrl!, "substrate_app") });
    cellctlPool = new Pool({ connectionString: roleUrl(databaseUrl!, "exomem_cellctl") });
    gatewayPool = new Pool({ connectionString: roleUrl(databaseUrl!, "exomem_gateway") });
  });

  after(async () => {
    await appPool?.end();
    await cellctlPool?.end();
    await gatewayPool?.end();
    await ownerPool?.end();
    if (schema) await adminPool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("gives substrate_app SELECT/INSERT/UPDATE/DELETE outside C1-C1d, C5 and C6, proven with a real round trip", async () => {
    const tableNames = await publicTableNames();
    const nonCloudTables = tableNames.filter(
      (name) =>
        !(C1_TABLES as readonly string[]).includes(name) &&
        name !== "schema_migrations" &&
        name !== "exomem_cloud_imports" &&
        name !== "exomem_cloud_exports"
    );
    assert.ok(nonCloudTables.length > 10, "sanity: the schema of record has plenty of non-Cloud tables");
    const privileges = await tablePrivileges("substrate_app", nonCloudTables);
    for (const name of nonCloudTables) {
      const grant = privileges[name]!;
      assert.ok(grant.select, `substrate_app should SELECT on ${name}`);
      assert.ok(grant.insert, `substrate_app should INSERT on ${name}`);
      assert.ok(grant.update, `substrate_app should UPDATE on ${name}`);
      assert.ok(grant.delete, `substrate_app should DELETE on ${name}`);
    }

    // One real INSERT/DELETE round trip, not just has_table_privilege: a
    // simple table with no NOT NULL foreign keys.
    const host = `grant-roundtrip-${randomUUID()}.example.test`;
    await appPool!.query(
      "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('claude', $1)",
      [host]
    );
    const found = await ownerPool!.query(
      "SELECT 1 FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1",
      [host]
    );
    assert.equal(found.rowCount, 1);
    await appPool!.query("DELETE FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1", [host]);
    const gone = await ownerPool!.query(
      "SELECT 1 FROM exomem_oauth_admitted_cimd_hosts WHERE host = $1",
      [host]
    );
    assert.equal(gone.rowCount, 0);
  });

  // D7: schema_migrations belongs to the migration runner. No runtime code
  // reads it, so substrate_app holds nothing on it, and a rerun of the
  // schema-wide grant never hands it back.
  it("gives substrate_app no privilege at all on schema_migrations", async () => {
    const privileges = await tablePrivileges("substrate_app", ["schema_migrations"]);
    assert.deepEqual(privileges.schema_migrations, {
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    await assert.rejects(appPool!.query("SELECT 1 FROM schema_migrations LIMIT 1"), /permission denied/);
  });

  it("grants substrate_app nothing extra on C1-C1d beyond the exact C1 privilege table -- no DELETE, no observed columns", async () => {
    const privileges = await tablePrivileges("substrate_app", C1_TABLES);
    for (const name of C1_TABLES) {
      // The C1 privilege table gives substrate_app SELECT on all four and a
      // narrow INSERT/UPDATE -- never DELETE. If the schema-wide grant had
      // leaked through (the REVOKE step not actually running, or running
      // before rather than after the schema-wide GRANT), DELETE would be
      // true here.
      assert.ok(privileges[name]!.select, `substrate_app should SELECT on ${name}`);
      assert.equal(privileges[name]!.delete, false, `substrate_app must not DELETE on ${name}`);
    }

    const tenantId = await newTenant();
    const id = cellId("h");
    await appPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    await appPool!.query("UPDATE exomem_cloud_cells SET desired_state = 'read_only' WHERE cell_id = $1", [
      id,
    ]);
    await assert.rejects(
      appPool!.query("UPDATE exomem_cloud_cells SET observed_state = 'running' WHERE cell_id = $1", [
        id,
      ]),
      /permission denied/
    );
    await assert.rejects(
      appPool!.query("UPDATE exomem_cloud_cells SET ready = true WHERE cell_id = $1", [id]),
      /permission denied/
    );
    await assert.rejects(
      appPool!.query("DELETE FROM exomem_cloud_cells WHERE cell_id = $1", [id]),
      /permission denied/
    );
  });

  // Item 5 / task 3.7, migration 0057: the cancellation-notice-sent claim
  // column substrate_app needs to run sendCloudCancellationNoticeOnce's
  // atomic UPDATE ... WHERE ... IS NULL claim.
  it("lets substrate_app claim the cancellation notice column", async () => {
    const tenantId = await newTenant();
    const id = cellId("n");
    await appPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    await appPool!.query(
      "UPDATE exomem_cloud_cells SET cancellation_notice_sent_at = now() WHERE cell_id = $1",
      [id]
    );
    const { rows } = await ownerPool!.query(
      "SELECT cancellation_notice_sent_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    assert.ok(rows[0]!.cancellation_notice_sent_at);
  });

  it("lets substrate_app mirror desired_state/status/deleted_at onto exomem_tenants via its ordinary schema-wide grant, but never the fence", async () => {
    const tenantId = await newTenant();
    await appPool!.query(
      "UPDATE exomem_tenants SET status = 'active', desired_state = 'running' WHERE id = $1",
      [tenantId]
    );
    await appPool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [tenantId]
    );
    const { rows } = await ownerPool!.query(
      "SELECT status, desired_state, deleted_at FROM exomem_tenants WHERE id = $1",
      [tenantId]
    );
    assert.equal(rows[0]!.status, "deleted");
    assert.equal(rows[0]!.desired_state, "deleted");
    assert.ok(rows[0]!.deleted_at);
    // Full column access now -- the narrow column-scoped grant this round
    // used to carry is gone, subsumed by the schema-wide grant.
    const owner = await appPool!.query("SELECT owner_user_id FROM exomem_tenants WHERE id = $1", [
      tenantId,
    ]);
    assert.equal(owner.rowCount, 1);
  });

  it("lets substrate_app write C1b and only the owner-route fields of C1d, never C1c", async () => {
    await appPool!.query(
      "INSERT INTO exomem_cloud_settings (key, value) VALUES ('cell_image', '\"sha256:app\"'::jsonb)"
    );
    await appPool!.query("UPDATE exomem_cloud_rollout SET paused = true WHERE id = 1");
    await assert.rejects(
      appPool!.query("UPDATE exomem_cloud_rollout SET last_good_image = 'x' WHERE id = 1"),
      /permission denied/
    );
    await assert.rejects(
      appPool!.query(
        "INSERT INTO exomem_cloud_capacity (node, cell_slots) VALUES ('node-app-denied', 1)"
      ),
      /permission denied/
    );
    await appPool!.query("UPDATE exomem_cloud_rollout SET paused = false WHERE id = 1");
  });

  it("lets exomem_cellctl write only C1 observed columns, never desired columns or an insert, and nothing schema-wide", async () => {
    const tenantId = await newTenant();
    const id = cellId("i");
    await ownerPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    await cellctlPool!.query(
      "UPDATE exomem_cloud_cells SET observed_state = 'running', ready = true WHERE cell_id = $1",
      [id]
    );
    await assert.rejects(
      cellctlPool!.query("UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE cell_id = $1", [
        id,
      ]),
      /permission denied/
    );
    await assert.rejects(
      cellctlPool!.query(
        "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
        [cellId("j"), tenantId]
      ),
      /permission denied/
    );
    await assert.rejects(cellctlPool!.query("SELECT 1 FROM exomem_tenants LIMIT 1"), /permission denied/);
  });

  // Migration 0059 (Exomem move-cloud-cells-to-local-storage D10): cellctl
  // records the size it grew a local cell's volume to. Without the grant every
  // growth would fail in production; substrate_app must never write it.
  it("lets exomem_cellctl record a cell's grown size, and substrate_app cannot", async () => {
    const tenantId = await newTenant();
    const id = cellId("m");
    await ownerPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    await cellctlPool!.query(
      "UPDATE exomem_cloud_cells SET grown_storage_gib = 8 WHERE cell_id = $1",
      [id]
    );
    const { rows } = await ownerPool!.query(
      "SELECT grown_storage_gib FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    assert.equal(rows[0]!.grown_storage_gib, 8);
    await assert.rejects(
      appPool!.query("UPDATE exomem_cloud_cells SET grown_storage_gib = 12 WHERE cell_id = $1", [
        id,
      ]),
      /permission denied/
    );
  });

  it("lets exomem_cellctl write C1c and its own C1d fields, never C1b", async () => {
    await cellctlPool!.query(
      "INSERT INTO exomem_cloud_capacity (node, cell_slots, attachments_used) VALUES ($1, 2, 0)",
      [`node-${randomUUID()}`]
    );
    await cellctlPool!.query("UPDATE exomem_cloud_rollout SET last_good_image = 'sha256:cellctl' WHERE id = 1");
    await assert.rejects(
      cellctlPool!.query(
        "INSERT INTO exomem_cloud_settings (key, value) VALUES ('rogue', '1'::jsonb)"
      ),
      /permission denied/
    );
  });

  it("lets exomem_gateway read only C1 routing columns, read/write rate-limit buckets, and nothing schema-wide", async () => {
    const tenantId = await newTenant();
    const id = cellId("k");
    await ownerPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    const routing = await gatewayPool!.query(
      "SELECT cell_id, tenant_id, desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [id]
    );
    assert.equal(routing.rows[0]!.cell_id, id);
    await assert.rejects(
      gatewayPool!.query("SELECT observed_state FROM exomem_cloud_cells WHERE cell_id = $1", [id]),
      /permission denied/
    );
    await assert.rejects(
      gatewayPool!.query("UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE cell_id = $1", [
        id,
      ]),
      /permission denied/
    );
    await gatewayPool!.query(
      `INSERT INTO exomem_rate_limit_buckets (scope, key_digest)
       VALUES ('exomem:gateway-test', $1)
       ON CONFLICT (scope, key_digest) DO UPDATE SET admitted_count = exomem_rate_limit_buckets.admitted_count + 1`,
      ["a".repeat(64)]
    );
    await gatewayPool!.query(
      `INSERT INTO exomem_rate_limit_buckets (scope, key_digest)
       VALUES ('exomem:gateway-test', $1)
       ON CONFLICT (scope, key_digest) DO UPDATE SET admitted_count = exomem_rate_limit_buckets.admitted_count + 1`,
      ["a".repeat(64)]
    );
    const bucket = await gatewayPool!.query(
      "SELECT admitted_count FROM exomem_rate_limit_buckets WHERE scope = 'exomem:gateway-test'"
    );
    assert.equal(bucket.rows[0]!.admitted_count, 2);
    await assert.rejects(
      gatewayPool!.query("SELECT 1 FROM exomem_cloud_settings LIMIT 1"),
      /permission denied/
    );
    // L3: exomem_gateway also reads the tenant's own status, column-scoped
    // exactly like every other table it runs findCloudOAuthAccessToken
    // against below, plus the narrow reviewer eligibility columns, never a write.
    const tenantRead = await gatewayPool!.query("SELECT id, status FROM exomem_tenants WHERE id = $1", [
      tenantId,
    ]);
    assert.equal(tenantRead.rows[0]!.id, tenantId);
    await assert.rejects(
      gatewayPool!.query("SELECT created_at FROM exomem_tenants WHERE id = $1", [tenantId]),
      /permission denied/
    );
    await assert.rejects(
      gatewayPool!.query("UPDATE exomem_tenants SET status = 'active' WHERE id = $1", [tenantId]),
      /permission denied/
    );
    await gatewayPool!.query("SELECT id, deleted_at FROM exomem_users LIMIT 1");
    await assert.rejects(gatewayPool!.query("SELECT email FROM exomem_users LIMIT 1"), /permission denied/);
    await assert.rejects(gatewayPool!.query("UPDATE exomem_users SET deleted_at = now()"), /permission denied/);
    await assert.rejects(gatewayPool!.query("SELECT id, deleted_at FROM users LIMIT 1"), /permission denied/);
    await assert.rejects(gatewayPool!.query("SELECT email FROM users LIMIT 1"), /permission denied/);
    await appPool!.query("SELECT original_email, proposed_email FROM exomem_email_changes LIMIT 1");
    await appPool!.query("SELECT observed_email FROM exomem_paddle_receipt_contacts LIMIT 1");
    await assert.rejects(
      gatewayPool!.query("SELECT * FROM exomem_email_changes LIMIT 1"),
      /permission denied/
    );
    await assert.rejects(
      gatewayPool!.query("SELECT * FROM exomem_paddle_receipt_contacts LIMIT 1"),
      /permission denied/
    );
    for (const column of ["password_hash", "username_digest"]) {
      await assert.rejects(
        gatewayPool!.query(`SELECT ${column} FROM exomem_marketplace_reviewer_credentials LIMIT 1`),
        /permission denied/
      );
    }
  });

  // Security review finding 3: the gateway connects to Postgres directly
  // (never through PgBouncer) and runs findCloudOAuthAccessToken itself --
  // this proves the column-scoped OAuth grants the script gives
  // exomem_gateway are exactly enough to run that real query, and nothing
  // more. A generic client is admitted through the generic arm, which reads
  // the lane flag: without that grant every generic client's MCP call would
  // fail in production while superuser tests passed.
  for (const lineage of ["ordinary", "reviewer", "generic"] as const) {
    it(`lets exomem_gateway run findCloudOAuthAccessToken for a real ${lineage} lineage`, async () => {
      const reviewerPurpose = lineage === "reviewer";
      const clientDbId = randomUUID();
      const host = `gateway-oauth-${randomUUID()}.example.test`;
      if (lineage === "generic") {
        await ownerPool!.query(
          `INSERT INTO exomem_oauth_clients (
           id, client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_name
         ) VALUES (
           $1, $2, 'generic', true, $3::jsonb, digest(convert_to($3::jsonb::text, 'utf8'), 'sha256'),
           'Gateway probe'
         )`,
          [clientDbId, randomUUID(), JSON.stringify(["http://127.0.0.1/callback"])],
        );
        await ownerPool!.query("UPDATE exomem_oauth_generic_client_lane SET enabled = true");
      } else {
        await ownerPool!.query(
          "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('claude', $1)",
          [host],
        );
        await ownerPool!.query(
          `INSERT INTO exomem_oauth_clients (
           id, client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
           metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
           cimd_host, client_platform, oauth_client_config_sha256
         ) VALUES (
           $1, $2, 'cimd', true, $3::jsonb, digest(convert_to($3::jsonb::text, 'utf8'), 'sha256'),
           $4, now(), 3600, now() + interval '1 hour', $5, 'claude', $6
         )`,
          [
            clientDbId,
            `https://${host}/client.json`,
            JSON.stringify([`https://${host}/callback`]),
            randomBytes(32),
            host,
            randomBytes(32).toString("hex"),
          ],
        );
      }
      const tenantId = await newTenant(reviewerPurpose);
      const owner = await ownerPool!.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
        [tenantId],
      );
      await ownerPool!.query(
        "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
        [cellId(lineage === "reviewer" ? "r" : lineage === "generic" ? "q" : "g"), tenantId],
      );
      let reviewerCredentialId: string | null = null;
      if (reviewerPurpose) {
        await ownerPool!.query(
          "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'complimentary_active', 'active')",
          [tenantId],
        );
        const credential = await ownerPool!.query<{ id: string }>(
          `INSERT INTO exomem_marketplace_reviewer_credentials (
           provider, username_digest, password_hash, owner_user_id, tenant_id, fixture_version,
           fixture_payload_digest, created_by_principal_digest, expires_at, credential_kind
         ) VALUES ('anthropic', $1, '$argon2id$test', $2, $3, 'sample-v1', $4, $5,
                   now() + interval '1 day', 'cloud_provider_review') RETURNING id`,
          [
            randomBytes(32),
            owner.rows[0]!.owner_user_id,
            tenantId,
            "a".repeat(64),
            randomBytes(32),
          ],
        );
        reviewerCredentialId = credential.rows[0]!.id;
      }
      const grant = await ownerPool!.query<{ id: string }>(
        `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes, reviewer_credential_id)
       VALUES ($1, $2, $3, $4, '{exomem.read,exomem.write}', $5) RETURNING id`,
        [owner.rows[0]!.owner_user_id, tenantId, clientDbId, CLOUD_RESOURCE, reviewerCredentialId],
      );
      const family = await ownerPool!.query<{ id: string }>(
        `INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at, reviewer_credential_id)
       VALUES ($1, $2, now() + interval '1 day', $3) RETURNING id`,
        [grant.rows[0]!.id, clientDbId, reviewerCredentialId],
      );
      const accessDigest = randomBytes(32);
      await ownerPool!.query(
        `INSERT INTO exomem_oauth_access_tokens (
         access_digest, grant_id, family_id, client_id, resource, scopes, expires_at, reviewer_credential_id
       ) VALUES ($1, $2, $3, $4, $5, '{exomem.read,exomem.write}', now() + interval '1 hour', $6)`,
        [
          accessDigest,
          grant.rows[0]!.id,
          family.rows[0]!.id,
          clientDbId,
          CLOUD_RESOURCE,
          reviewerCredentialId,
        ],
      );

      const previousReviewer = process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED;
      process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = "true";
      __setExomemSqlForTests(taggedSql(gatewayPool!));
      try {
        const found = await findCloudOAuthAccessToken(accessDigest, CLOUD_RESOURCE);
        assert.ok(found, "exomem_gateway should be able to run the real lookup query");
        assert.equal(found!.tenantId, tenantId);
        assert.equal(found!.cellDesiredState, "running");
        assert.equal(found!.firstParty, false);
        // The gateway then records the app's use, twice as a busy app would.
        await recordCloudAppUse(found!.grantId);
        await recordCloudAppUse(found!.grantId);
        const recorded = await ownerPool!.query(
          "SELECT last_used_at FROM exomem_oauth_grant_usage WHERE grant_id = $1",
          [found!.grantId],
        );
        assert.equal(recorded.rowCount, 1);
        if (reviewerPurpose) {
          await ownerPool!.query(
            "UPDATE exomem_entitlements SET source = 'paddle', provider_customer_ref = 'ctm_test', provider_environment = 'sandbox' WHERE tenant_id = $1",
            [tenantId],
          );
          assert.equal(await findCloudOAuthAccessToken(accessDigest, CLOUD_RESOURCE), null);
        }
      } finally {
        __setExomemSqlForTests(null);
        if (lineage === "generic") {
          await ownerPool!.query("UPDATE exomem_oauth_generic_client_lane SET enabled = false");
        }
        if (previousReviewer === undefined)
          delete process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED;
        else process.env.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED = previousReviewer;
      }
    });
  }

  // D7 round item 1's last bullet, restated for evidence: no function or
  // procedure here needs an explicit EXECUTE grant. Every trigger/CHECK
  // function keeps Postgres's default PUBLIC EXECUTE, and pgcrypto's
  // digest()/gen_random_uuid() are PUBLIC-executable extension functions --
  // exomem_gateway (no schema-wide grant at all) can still call digest()
  // inside the query above without any grant naming it, which is the
  // sharpest proof available that no additional EXECUTE grant is needed.

  it("lets a table (and its sequence) created by substrate_owner after the fact inherit the same grants automatically", async () => {
    await ownerPool!.query("CREATE TABLE later_migration_probe (id bigserial PRIMARY KEY, note text)");
    try {
      const privileges = await tablePrivileges("substrate_app", ["later_migration_probe"]);
      assert.ok(privileges.later_migration_probe!.select);
      assert.ok(privileges.later_migration_probe!.insert);
      assert.ok(privileges.later_migration_probe!.update);
      assert.ok(privileges.later_migration_probe!.delete);

      // pg_get_serial_sequence already returns a suitably schema-qualified,
      // quoted name -- wrapping it in quote_ident() would double-quote the
      // whole dotted string as one identifier and break the lookup.
      const sequence = await ownerPool!.query<{ can_usage: boolean; can_select: boolean }>(
        `SELECT has_sequence_privilege('substrate_app', pg_get_serial_sequence('later_migration_probe', 'id'), 'USAGE') AS can_usage,
                has_sequence_privilege('substrate_app', pg_get_serial_sequence('later_migration_probe', 'id'), 'SELECT') AS can_select`
      );
      assert.ok(sequence.rows[0]!.can_usage, "substrate_app should have USAGE on a later-created sequence");
      assert.ok(sequence.rows[0]!.can_select, "substrate_app should have SELECT on a later-created sequence");

      const inserted = await appPool!.query<{ id: string }>(
        "INSERT INTO later_migration_probe (note) VALUES ('ok') RETURNING id"
      );
      assert.ok(inserted.rows[0]!.id, "the sequence-backed id must actually be usable by substrate_app");
    } finally {
      await ownerPool!.query("DROP TABLE later_migration_probe");
    }
  });

  // D7 round item 3: at least one admission -> reconcile path run AS
  // substrate_app instead of a superuser -- proof the exact grant set above
  // (not a broader test-only connection) is what the real admission and
  // lifecycle code paths actually run under.
  it("runs admission and reconcile end to end AS substrate_app, not a superuser", async () => {
    // A generous slot count: earlier tests in this file leave their own
    // fixture cell rows around (they are not the object under test there),
    // so capacity here only needs to comfortably clear whatever they left,
    // not describe a real fleet size.
    await ownerPool!.query("DELETE FROM exomem_cloud_capacity");
    await ownerPool!.query("INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at) VALUES ($1, 1000, now())", [
      `node-${randomUUID()}`,
    ]);
    const tokenDigest = randomBytes(32);
    await ownerPool!.query(
      `INSERT INTO exomem_invites (
         token_digest, email_normalized, entitlement_source, entitlement_capabilities,
         entitlement_limits, created_by_principal_digest, expires_at
       ) VALUES ($1, $2, 'complimentary', '["capture","recall"]'::jsonb, '{}'::jsonb, $3, now() + interval '1 day')`,
      [tokenDigest, `cloud-grants-admission-${randomUUID()}@example.test`, randomBytes(32)]
    );

    async function interactiveAppTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
      const client = await appPool!.connect();
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

    __setExomemSqlForTests(taggedSql(appPool!));
    __setExomemTransactionForTests(interactiveAppTransaction);
    try {
      const admitted = await redeemCloudInviteAtomic({
        tokenDigest,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 3600_000),
      });
      assert.ok(admitted, "substrate_app's grants should be sufficient to run admission for real");
      assert.equal(admitted!.cellId.length, 16);

      const target = await reconcileCloudCellDesiredState(admitted!.tenantId);
      assert.equal(
        target,
        "running",
        "substrate_app's grants should be sufficient to run reconcile for real, on a complimentary tenant"
      );
    } finally {
      __setExomemSqlForTests(null);
      __setExomemTransactionForTests(null);
    }
  });

  it("changes nothing on a second application (relacl/attacl snapshot)", async () => {
    const before1 = await aclSnapshot();
    const ownerUrl = roleUrl(databaseUrl!, "substrate_owner");
    await applyMigrations({ databaseUrl: ownerUrl });
    const after1 = await aclSnapshot();
    assert.deepEqual(after1, before1);
  });
  it("enforces C5 request/observation grants after inherited grants and reruns", async () => {
    const tenantId = await newTenant();
    const id = randomCloudCellId();
    await appPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [id, tenantId]
    );
    const created = await appPool!.query(
      "INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files) VALUES ($1, 'adopt', 12, 1) RETURNING import_id",
      [id]
    );
    const importId = created.rows[0].import_id;
    await cellctlPool!.query(
      "UPDATE exomem_cloud_imports SET recipient = 'age1test', observed_state = 'key_ready' WHERE import_id = $1",
      [importId]
    );
    await appPool!.query(
      "UPDATE exomem_cloud_imports SET ciphertext_sha256 = $2, ciphertext_bytes = 128 WHERE import_id = $1",
      [importId, "a".repeat(64)]
    );
    await cellctlPool!.query(
      "UPDATE exomem_cloud_cells SET hold_kind = 'import' WHERE cell_id = $1",
      [id]
    );
    await assert.rejects(
      ownerPool!.query("DELETE FROM exomem_cloud_cells WHERE cell_id = $1", [id]),
      /foreign key/
    );

    // Simulate default table grants left by a migration before the runner applies its exceptions.
    await ownerPool!.query(
      "GRANT ALL ON exomem_cloud_imports TO substrate_app, exomem_cellctl, exomem_gateway, PUBLIC"
    );
    await applyMigrations({ databaseUrl: roleUrl(databaseUrl!, "substrate_owner") });
    for (const client of [appPool!, cellctlPool!, gatewayPool!]) {
      await assert.rejects(
        client.query("DELETE FROM exomem_cloud_imports WHERE import_id = $1", [importId]),
        /permission denied/
      );
    }
    await assert.rejects(
      appPool!.query(
        "UPDATE exomem_cloud_imports SET recipient = 'replacement' WHERE import_id = $1",
        [importId]
      ),
      /permission denied/
    );
    await assert.rejects(
      appPool!.query(
        "INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files, observed_state) VALUES ($1, 'adopt', 1, 1, 'done')",
        [id]
      ),
      /permission denied/
    );
    await assert.rejects(
      cellctlPool!.query(
        "UPDATE exomem_cloud_imports SET ciphertext_bytes = 129 WHERE import_id = $1",
        [importId]
      ),
      /permission denied/
    );
    await assert.rejects(
      cellctlPool!.query(
        "UPDATE exomem_cloud_imports SET requested_state = 'uploaded' WHERE import_id = $1",
        [importId]
      ),
      /permission denied/
    );
    await assert.rejects(
      cellctlPool!.query(
        "INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files) VALUES ($1, 'adopt', 1, 1)",
        [id]
      ),
      /permission denied/
    );
    await assert.rejects(
      gatewayPool!.query("SELECT import_id FROM exomem_cloud_imports"),
      /permission denied/
    );
    await assert.rejects(
      gatewayPool!.query("UPDATE exomem_cloud_imports SET requested_state = 'cancelled'"),
      /permission denied/
    );
    await appPool!.query(
      'UPDATE exomem_cloud_imports SET part_etags = \'[{"part_number":1,"etag":"accepted"}]\', requested_state = \'uploaded\' WHERE import_id = $1',
      [importId]
    );
    await cellctlPool!.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'cleanup_pending', error_code = 'IMPORT_FAILED', part_urls = NULL WHERE import_id = $1",
      [importId]
    );
    await assert.rejects(
      appPool!.query(
        "UPDATE exomem_cloud_imports SET observed_state = 'discarded' WHERE import_id = $1",
        [importId]
      ),
      /permission denied/
    );
    await assert.rejects(
      appPool!.query(
        "INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files) VALUES ($1, 'adopt', 1, 1)",
        [id]
      ),
      { code: "23505" }
    );
    assert.deepEqual(
      (
        await appPool!.query(
          "SELECT observed_state, error_code FROM exomem_cloud_imports WHERE import_id = $1",
          [importId]
        )
      ).rows[0],
      { observed_state: "cleanup_pending", error_code: "IMPORT_FAILED" }
    );
    await cellctlPool!.query(
      "UPDATE exomem_cloud_imports SET observed_state = 'failed' WHERE import_id = $1",
      [importId]
    );
    await appPool!.query(
      "INSERT INTO exomem_cloud_imports (cell_id, kind, declared_bytes, declared_files) VALUES ($1, 'adopt', 1, 1)",
      [id]
    );
    assert.equal(
      (
        await appPool!.query(
          "SELECT observed_state FROM exomem_cloud_imports WHERE import_id = $1",
          [importId]
        )
      ).rows[0].observed_state,
      "failed"
    );
  });

  // C6: Substrate writes the request columns, cellctl the observation
  // columns, and the gateway has no privilege at all; cellctl alone writes the
  // C1 disk-use columns. Checked against every column, after a blanket grant
  // and a rerun, so a column added later without a grant decision shows up.
  it("holds each role to exactly its C6 columns, and gives the gateway nothing on C6", async () => {
    await ownerPool!.query(
      "GRANT ALL ON exomem_cloud_exports TO substrate_app, exomem_cellctl, exomem_gateway, PUBLIC"
    );
    await applyMigrations({ databaseUrl: roleUrl(databaseUrl!, "substrate_owner") });

    async function columnPrivileges(role: string, table: string, privilege: string) {
      const { rows } = await ownerPool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $2
           AND has_column_privilege($1, quote_ident($2), column_name, $3)
         ORDER BY column_name`,
        [role, table, privilege]
      );
      return rows.map((row) => row.column_name);
    }
    const allColumns = (
      await ownerPool!.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'exomem_cloud_exports'
         ORDER BY column_name`
      )
    ).rows.map((row) => row.column_name);

    assert.deepEqual(await columnPrivileges("substrate_app", "exomem_cloud_exports", "SELECT"), allColumns);
    assert.deepEqual(await columnPrivileges("substrate_app", "exomem_cloud_exports", "INSERT"), [
      "cell_id",
      "export_id",
      "link_requested_at",
      "requested_state",
    ]);
    assert.deepEqual(await columnPrivileges("substrate_app", "exomem_cloud_exports", "UPDATE"), [
      "link_requested_at",
      "requested_state",
    ]);
    assert.deepEqual(await columnPrivileges("exomem_cellctl", "exomem_cloud_exports", "SELECT"), allColumns);
    assert.deepEqual(await columnPrivileges("exomem_cellctl", "exomem_cloud_exports", "INSERT"), []);
    assert.deepEqual(await columnPrivileges("exomem_cellctl", "exomem_cloud_exports", "UPDATE"), [
      "archive_bytes",
      "archive_sha256",
      "archive_version_id",
      "download_url",
      "download_url_expires_at",
      "error_code",
      "expires_at",
      "link_issued_at",
      "observed_state",
      "ready_at",
      "upload_id",
    ]);
    for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
      assert.deepEqual(await columnPrivileges("exomem_gateway", "exomem_cloud_exports", privilege), []);
    }
    for (const role of CLOUD_ROLES) {
      const { rows } = await ownerPool!.query<{ can_delete: boolean }>(
        "SELECT has_table_privilege($1, 'exomem_cloud_exports', 'DELETE') AS can_delete",
        [role]
      );
      assert.equal(rows[0]!.can_delete, false, `${role} must not delete export rows`);
    }

    const usage = ["filesystem_bytes", "usage_observed_at", "used_bytes"];
    const cellctlUpdates = await columnPrivileges("exomem_cellctl", "exomem_cloud_cells", "UPDATE");
    assert.deepEqual(cellctlUpdates.filter((column) => usage.includes(column)), usage);
    const appUpdates = await columnPrivileges("substrate_app", "exomem_cloud_cells", "UPDATE");
    assert.deepEqual(appUpdates.filter((column) => usage.includes(column)), []);
    const gatewayReads = await columnPrivileges("exomem_gateway", "exomem_cloud_cells", "SELECT");
    assert.deepEqual(gatewayReads.filter((column) => usage.includes(column)), []);
  });

  it("runs the Home mint and the export request AS substrate_app, and the gateway resolves the Home token AS exomem_gateway", async () => {
    const resourceEnv = {
      EXOMEM_CLOUD_MCP_URL: CLOUD_RESOURCE,
      EXOMEM_CLOUD_MCP_PATH: "/mcp/v1",
      EXOMEM_CLOUD_HOME_CHANNEL_ENABLED: "true",
      EXOMEM_CLOUD_EXPORTS_ENABLED: "true",
    };
    const tenantId = await newTenant();
    const owner = await ownerPool!.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
      [tenantId]
    );
    const userId = owner.rows[0]!.owner_user_id;
    const homeCellId = randomCloudCellId();
    await ownerPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [homeCellId, tenantId]
    );
    await ownerPool!.query(
      "UPDATE exomem_cloud_cells SET ready = true, observed_state = 'running', observed_image = 'registry.example.test/exomem@sha256:' || repeat('c', 64) WHERE cell_id = $1",
      [homeCellId]
    );
    const cookie = generateExternalToken();
    const csrf = generateExternalToken();
    await ownerPool!.query(
      "INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')",
      [userId, tenantId, digestSecret(cookie), digestSecret(csrf)]
    );
    const browser = (method: string, path: string, body?: unknown) =>
      new Request(`https://app.example.test${path}`, {
        method,
        headers: {
          cookie: `exomem_session=${cookie}; exomem_csrf=${csrf}`,
          origin: "https://app.example.test",
          host: "app.example.test",
          "x-exomem-csrf": csrf,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    async function appTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
      const client = await appPool!.connect();
      try {
        await client.query("BEGIN");
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

    let routed: { cellId: string; firstParty: boolean } | undefined;
    const fetchCell = (async (_url: string, init: RequestInit) => {
      const bearer = new Headers(init.headers).get("authorization")!.slice("Bearer ".length);
      __setExomemSqlForTests(taggedSql(gatewayPool!));
      try {
        routed = (await findCloudOAuthAccessToken(digestSecret(bearer), CLOUD_RESOURCE)) ?? undefined;
      } finally {
        __setExomemSqlForTests(taggedSql(appPool!));
      }
      const levels = { level: "balanced", source: "default" };
      return Response.json({
        jsonrpc: "2.0",
        id: JSON.parse(String(init.body)).id,
        result: {
          isError: false,
          structuredContent: { revision: "r1", levels: { coding: levels, conversation: levels } },
        },
      });
    }) as unknown as typeof fetch;

    __setExomemSqlForTests(taggedSql(appPool!));
    __setExomemTransactionForTests(appTransaction);
    try {
      const levels = await handleCloudHomeLevelsRequest(browser("GET", "/api/exomem/cloud/home/levels"), {
        fetchCell,
        env: resourceEnv,
      });
      assert.equal(levels.status, 200);
      assert.equal(routed?.cellId, homeCellId);
      assert.equal(routed?.firstParty, true);

      const started = await handleCloudExportsRequest(browser("POST", "/api/exomem/cloud/exports", {}), {
        env: resourceEnv,
      });
      assert.equal(started.status, 201);
      const exportId = ((await started.json()) as { export: { export_id: string } }).export.export_id;
      await cellctlPool!.query(
        `UPDATE exomem_cloud_exports
         SET observed_state = 'ready', archive_bytes = 10, archive_sha256 = repeat('d', 64),
             ready_at = now(), expires_at = now() + interval '1 day'
         WHERE export_id = $1`,
        [exportId]
      );
      const answering = (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const { rowCount } = await cellctlPool!.query(
            `UPDATE exomem_cloud_exports
             SET download_url = 'https://objects.example.test/archive', download_url_expires_at = now() + interval '5 minutes',
                 link_issued_at = GREATEST(clock_timestamp(), COALESCE(link_requested_at, '-infinity'))
             WHERE export_id = $1 AND link_requested_at IS NOT NULL`,
            [exportId]
          );
          if (rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
      const link = await handleCloudExportLinkRequest(
        browser("POST", `/api/exomem/cloud/exports/${exportId}/link`),
        exportId,
        { env: resourceEnv, linkWaitMs: 4_000 }
      );
      await answering;
      assert.equal(link.status, 200);
    } finally {
      __setExomemSqlForTests(null);
      __setExomemTransactionForTests(null);
    }
  });
});
