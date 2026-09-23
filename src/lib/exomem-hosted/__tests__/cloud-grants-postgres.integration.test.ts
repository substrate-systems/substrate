import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { redeemCloudInviteAtomic } from "../cloud-admission";
import { reconcileCloudCellDesiredState } from "../cloud-lifecycle";
import { findCloudOAuthAccessToken } from "../cloud-oauth";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
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

async function newTenant(): Promise<string> {
  const email = `cloud-grants-${randomUUID()}@example.test`;
  const user = await ownerPool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email]
  );
  const tenant = await ownerPool!.query<{ id: string }>(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [user.rows[0]!.id]
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

  it("gives substrate_app SELECT/INSERT/UPDATE/DELETE on every public table except C1-C1d, proven with a real round trip", async () => {
    const tableNames = await publicTableNames();
    const nonCloudTables = tableNames.filter((name) => !(C1_TABLES as readonly string[]).includes(name));
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
    await assert.rejects(gatewayPool!.query("SELECT 1 FROM exomem_tenants LIMIT 1"), /permission denied/);
    await assert.rejects(gatewayPool!.query("SELECT 1 FROM users LIMIT 1"), /permission denied/);
  });

  // Security review finding 3: the gateway connects to Postgres directly
  // (never through PgBouncer) and runs findCloudOAuthAccessToken itself --
  // this proves the column-scoped OAuth grants the script gives
  // exomem_gateway are exactly enough to run that real query, and nothing
  // more.
  it("lets exomem_gateway run findCloudOAuthAccessToken for real, and denies it every table beyond that", async () => {
    const clientDbId = randomUUID();
    const host = `gateway-oauth-${randomUUID()}.example.test`;
    await ownerPool!.query("INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('claude', $1)", [
      host,
    ]);
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
      ]
    );
    const tenantId = await newTenant();
    const owner = await ownerPool!.query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
      [tenantId]
    );
    await ownerPool!.query(
      "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
      [cellId("g"), tenantId]
    );
    const grant = await ownerPool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_grants (user_id, tenant_id, client_id, resource, scopes)
       VALUES ($1, $2, $3, $4, '{exomem.read,exomem.write}') RETURNING id`,
      [owner.rows[0]!.owner_user_id, tenantId, clientDbId, CLOUD_RESOURCE]
    );
    const family = await ownerPool!.query<{ id: string }>(
      `INSERT INTO exomem_oauth_token_families (grant_id, client_id, expires_at)
       VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
      [grant.rows[0]!.id, clientDbId]
    );
    const accessDigest = randomBytes(32);
    await ownerPool!.query(
      `INSERT INTO exomem_oauth_access_tokens (
         access_digest, grant_id, family_id, client_id, resource, scopes, expires_at
       ) VALUES ($1, $2, $3, $4, $5, '{exomem.read,exomem.write}', now() + interval '1 hour')`,
      [accessDigest, grant.rows[0]!.id, family.rows[0]!.id, clientDbId, CLOUD_RESOURCE]
    );

    __setExomemSqlForTests(taggedSql(gatewayPool!));
    try {
      const found = await findCloudOAuthAccessToken(accessDigest, CLOUD_RESOURCE);
      assert.ok(found, "exomem_gateway should be able to run the real lookup query");
      assert.equal(found!.tenantId, tenantId);
      assert.equal(found!.cellDesiredState, "running");
    } finally {
      __setExomemSqlForTests(null);
    }
  });

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
    await ownerPool!.query("INSERT INTO exomem_cloud_capacity (node, cell_slots) VALUES ($1, 1000)", [
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
});
