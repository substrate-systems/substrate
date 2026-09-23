import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { admitFirstCloudOAuthInviteAtomic, randomCloudCellId } from "../cloud-admission";
import { reconcileCloudCellDesiredState, runBoundedCloudReconcile } from "../cloud-lifecycle";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { issueOAuthTokensFromCodeAtomic } from "../oauth-store";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Task 3.7: entitlement -> Cloud cell desired_state (design D4) against real
// PostgreSQL, including the cancelled-tenant export window and its
// generation bump.
//
// This round (deviations 2/3): reconcileCloudCellDesiredState also mirrors
// exomem_tenants.status/desired_state in the same transaction as the cell's
// desired_state write, so the tests below assert both tenant columns per D4
// transition, plus one direct-Postgres check that the mirror actually
// changes issueOAuthTokensFromCodeAtomic's real behavior for a stopped
// Cloud tenant (and does not for a read_only one).

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

// Tests share one schema across the file; a prior test's tenants, entitlements
// and cells must not leak into the next one's fleet.
async function resetFleet(): Promise<void> {
  // OAuth fixtures first (only the token-gate test below populates these) --
  // codes reference grants, grants reference tenants/transactions, so they
  // must go before those tables clear, matching
  // cloud-admission-postgres.integration.test.ts's own resetFleet ordering.
  await pool!.query("DELETE FROM exomem_oauth_authorization_codes");
  await pool!.query("DELETE FROM exomem_oauth_grants");
  await pool!.query("DELETE FROM exomem_oauth_authorization_transactions");
  await pool!.query("DELETE FROM exomem_oauth_clients");
  await pool!.query("DELETE FROM exomem_invites");
  await pool!.query("DELETE FROM exomem_sessions");
  await pool!.query("DELETE FROM exomem_entitlements");
  await pool!.query("DELETE FROM exomem_cloud_cells");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM users");
  await pool!.query("DELETE FROM exomem_cloud_capacity");
}

async function configureCapacity(slots: number): Promise<void> {
  await pool!.query(
    "INSERT INTO exomem_cloud_capacity (node, cell_slots) VALUES ($1, $2)",
    [`node-${randomUUID()}`, slots]
  );
}

/**
 * A minimal, real Cloud OAuth admission fixture -- one CIMD-admitted client,
 * one complimentary invite and one authorization transaction -- copied from
 * cloud-admission-postgres.integration.test.ts's own createCloudOAuthFixture
 * (task 3.3/3.4), extended to also return the client's string client_id and
 * redirect_uri, both of which issueOAuthTokensFromCodeAtomic needs directly.
 */
async function createCloudOAuthFixture(): Promise<{
  inviteDigest: Buffer;
  transactionDigest: Buffer;
  clientId: string;
  redirectUri: string;
}> {
  const clientId = `https://cloud-lifecycle-fixture-${randomUUID()}.example.test/client.json`;
  const host = new URL(clientId).hostname;
  await pool!.query(
    "INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host) VALUES ('claude', $1) ON CONFLICT DO NOTHING",
    [host]
  );
  const redirectUris = [`https://${host}/callback`];
  const clientRow = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_oauth_clients (
       client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
       metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
       cimd_host, client_platform, oauth_client_config_sha256
     ) VALUES (
       $1, 'cimd', true, $2::jsonb, digest(convert_to($2::jsonb::text, 'utf8'), 'sha256'),
       $3, now(), 3600, now() + interval '1 hour', $4, 'claude', $5
     ) RETURNING id`,
    [clientId, JSON.stringify(redirectUris), randomBytes(32), host, randomBytes(32).toString("hex")]
  );
  const clientInternalId = clientRow.rows[0]!.id;

  const inviteDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, 'complimentary', '["capture","recall"]'::jsonb, '{}'::jsonb, $3, now() + interval '1 day')`,
    [inviteDigest, `cloud-lifecycle-oauth-${randomUUID()}@example.test`, randomBytes(32)]
  );

  const transactionDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_oauth_authorization_transactions (
       transaction_digest, client_id, redirect_uri, resource, requested_scopes,
       state_digest, state_envelope, form_nonce_digest, continuation_binding, pkce_challenge, expires_at
     ) VALUES ($1, $2, $3, 'https://cloud.example.test/mcp/v1', ARRAY['exomem.read'],
       $4, '{}'::jsonb, $5, $6, 'challenge', now() + interval '1 hour')`,
    [
      transactionDigest,
      clientInternalId,
      redirectUris[0],
      randomBytes(32),
      randomBytes(32),
      randomBytes(32),
    ]
  );

  return { inviteDigest, transactionDigest, clientId, redirectUri: redirectUris[0] };
}

type SeedInput = {
  source: "complimentary" | "paddle";
  sourceState: string;
  manuallySuspended?: boolean;
  sourceOccurredAt?: Date | null;
  initialDesiredState?: "running" | "read_only" | "stopped" | "deleted";
};

/** Seeds a user, tenant, entitlement and one active Cloud cell row. */
async function seedTenant(input: SeedInput): Promise<{ tenantId: string; cellId: string }> {
  const userResult = await pool!.query(
    "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
    [`cloud-lifecycle-${randomUUID()}@example.test`]
  );
  const userId = userResult.rows[0].id as string;

  const tenantResult = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [userId]
  );
  const tenantId = tenantResult.rows[0].id as string;

  await pool!.query(
    `INSERT INTO exomem_entitlements (
       tenant_id, source, source_state, effective_state, manual_suspended_at, source_occurred_at
     ) VALUES ($1, $2, $3, 'active', $4, $5)`,
    [
      tenantId,
      input.source,
      input.sourceState,
      input.manuallySuspended ? new Date() : null,
      input.sourceOccurredAt === undefined ? new Date() : input.sourceOccurredAt,
    ]
  );

  const cellId = randomCloudCellId();
  await pool!.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, input.initialDesiredState ?? "stopped"]
  );

  return { tenantId, cellId };
}

async function cellState(cellId: string): Promise<{ desiredState: string; generation: number }> {
  const { rows } = await pool!.query(
    "SELECT desired_state, generation FROM exomem_cloud_cells WHERE cell_id = $1",
    [cellId]
  );
  return { desiredState: rows[0].desired_state as string, generation: Number(rows[0].generation) };
}

/**
 * This round's ruling: the tenant row mirrors the Cloud cell. Asserted after
 * every D4 transition below, alongside cellState. A freshly seeded tenant's
 * un-mirrored defaults are status='provisioning', desired_state='running'
 * (migration 0017's column defaults) -- the read_only case is expected to
 * leave those defaults untouched, since exomem_tenants has no read_only-
 * equivalent value in either column's CHECK constraint.
 */
async function tenantState(
  tenantId: string
): Promise<{ status: string; desiredState: string; deletedAt: Date | null }> {
  const { rows } = await pool!.query(
    "SELECT status, desired_state, deleted_at FROM exomem_tenants WHERE id = $1",
    [tenantId]
  );
  return {
    status: rows[0].status as string,
    desiredState: rows[0].desired_state as string,
    deletedAt: rows[0].deleted_at as Date | null,
  };
}

// admitFirstCloudOAuthInviteAtomic (called from this file's one
// admitOneCloudTenant helper) loads the Cloud resource URL via
// loadExomemCloudConfig() (security review finding 15), which reads real
// process.env -- needed for the whole suite, restored afterwards.
const CLOUD_CONFIG_ENV = {
  EXOMEM_CLOUD_MCP_URL: "https://cloud.example.test/mcp/v1",
  EXOMEM_CLOUD_MCP_PATH: "/api/exomem/cloud/mcp/v1",
  EXOMEM_CLOUD_CELL_TOKEN_KEY: "a".repeat(64),
} as const;
const priorCloudConfigEnv: Partial<Record<keyof typeof CLOUD_CONFIG_ENV, string | undefined>> = {};

describe("Exomem Cloud lifecycle reconciliation PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const key of Object.keys(CLOUD_CONFIG_ENV) as Array<keyof typeof CLOUD_CONFIG_ENV>) {
      priorCloudConfigEnv[key] = process.env[key];
      process.env[key] = CLOUD_CONFIG_ENV[key];
    }
    schema = `cloud_lifecycle_it_${randomUUID().replaceAll("-", "")}`;
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
    for (const key of Object.keys(CLOUD_CONFIG_ENV) as Array<keyof typeof CLOUD_CONFIG_ENV>) {
      if (priorCloudConfigEnv[key] === undefined) delete process.env[key];
      else process.env[key] = priorCloudConfigEnv[key];
    }
  });

  it("moves a complimentary-active tenant to running", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({ source: "complimentary", sourceState: "complimentary_active" });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "running");
    assert.equal((await cellState(cellId)).desiredState, "running");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "active");
    assert.equal(tenant.desiredState, "running");
    assert.equal(tenant.deletedAt, null);
  });

  it("moves an active paddle subscription to running", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({ source: "paddle", sourceState: "active" });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "running");
    assert.equal((await cellState(cellId)).desiredState, "running");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "active");
    assert.equal(tenant.desiredState, "running");
  });

  it("moves a trialing paddle subscription to running", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({ source: "paddle", sourceState: "trialing" });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "running");
    assert.equal((await cellState(cellId)).desiredState, "running");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "active");
    assert.equal(tenant.desiredState, "running");
  });

  it("moves a past_due (grace) paddle subscription to read_only, leaving the tenant mirror untouched", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "past_due",
      initialDesiredState: "running",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "read_only");
    assert.equal((await cellState(cellId)).desiredState, "read_only");
    // exomem_tenants has no read_only-equivalent value in either column's
    // CHECK constraint (migration 0017: status IN ('provisioning','active',
    // 'suspended','deletion_pending','deleted'); desired_state IN
    // ('running','suspended','deleted')) -- the mirror write is skipped, so
    // the tenant keeps its last-mirrored (here: freshly seeded default)
    // status/desired_state, which is exactly what keeps the OAuth token gate
    // (oauth-store.ts: status IN ('provisioning','active') AND desired_state
    // = 'running') issuing tokens while the cell still serves reads.
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "provisioning");
    assert.equal(tenant.desiredState, "running");
  });

  it("moves a provider-paused paddle subscription to read_only, leaving the tenant mirror untouched", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "paused",
      initialDesiredState: "running",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "read_only");
    assert.equal((await cellState(cellId)).desiredState, "read_only");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "provisioning");
    assert.equal(tenant.desiredState, "running");
  });

  it("moves a manually suspended tenant to stopped regardless of source", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      manuallySuspended: true,
      initialDesiredState: "running",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "stopped");
    assert.equal((await cellState(cellId)).desiredState, "stopped");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "suspended");
    assert.equal(tenant.desiredState, "suspended");
  });

  it("moves a manually suspended paddle tenant (the 'revoked' case) to stopped", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "active",
      manuallySuspended: true,
      initialDesiredState: "running",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "stopped");
    assert.equal((await cellState(cellId)).desiredState, "stopped");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "suspended");
    assert.equal(tenant.desiredState, "suspended");
  });

  it("keeps a freshly cancelled tenant read_only within the export window, leaving the tenant mirror untouched", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: new Date(),
      initialDesiredState: "running",
    });
    const target = await reconcileCloudCellDesiredState(tenantId, { cancelledRetentionDays: 30 });
    assert.equal(target, "read_only");
    assert.equal((await cellState(cellId)).desiredState, "read_only");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "provisioning");
    assert.equal(tenant.desiredState, "running");
  });

  it("deletes a cancelled tenant once the export window has elapsed, bumping generation", async () => {
    await resetFleet();
    const cancelledAt = new Date("2026-01-01T00:00:00Z");
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: cancelledAt,
      initialDesiredState: "read_only",
    });
    const before_ = await cellState(cellId);
    const justPastWindow = new Date(cancelledAt.getTime() + 30 * 24 * 60 * 60 * 1000 + 1000);
    const target = await reconcileCloudCellDesiredState(tenantId, {
      cancelledRetentionDays: 30,
      now: justPastWindow,
    });
    assert.equal(target, "deleted");
    const after_ = await cellState(cellId);
    assert.equal(after_.desiredState, "deleted");
    assert.ok(after_.generation > before_.generation, "generation must bump on the read_only -> deleted transition");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "deleted");
    assert.equal(tenant.desiredState, "deleted");
    assert.notEqual(tenant.deletedAt, null);
  });

  it("does not yet delete a cancelled tenant exactly at the window boundary minus a moment", async () => {
    await resetFleet();
    const cancelledAt = new Date("2026-01-01T00:00:00Z");
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: cancelledAt,
      initialDesiredState: "read_only",
    });
    const justBeforeWindow = new Date(cancelledAt.getTime() + 30 * 24 * 60 * 60 * 1000 - 1000);
    const target = await reconcileCloudCellDesiredState(tenantId, {
      cancelledRetentionDays: 30,
      now: justBeforeWindow,
    });
    assert.equal(target, "read_only");
    assert.equal((await cellState(cellId)).desiredState, "read_only");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "provisioning");
    assert.equal(tenant.desiredState, "running");
  });

  it("returns a resubscription within the cancelled window to running", async () => {
    await resetFleet();
    const cancelledAt = new Date("2026-01-01T00:00:00Z");
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: cancelledAt,
      initialDesiredState: "running",
    });
    const stillWithinWindow = new Date(cancelledAt.getTime() + 5 * 24 * 60 * 60 * 1000);
    const cancelledTarget = await reconcileCloudCellDesiredState(tenantId, {
      cancelledRetentionDays: 30,
      now: stillWithinWindow,
    });
    assert.equal(cancelledTarget, "read_only");
    assert.equal((await cellState(cellId)).desiredState, "read_only");
    assert.deepEqual(await tenantState(tenantId), {
      status: "provisioning",
      desiredState: "running",
      deletedAt: null,
    });

    // Resubscribing turns the entitlement back to an active paddle
    // subscription — exactly what the real webhook path does.
    await pool!.query("UPDATE exomem_entitlements SET source_state = 'active' WHERE tenant_id = $1", [
      tenantId,
    ]);
    const resubscribedTarget = await reconcileCloudCellDesiredState(tenantId, {
      cancelledRetentionDays: 30,
      now: stillWithinWindow,
    });
    assert.equal(resubscribedTarget, "running");
    assert.equal((await cellState(cellId)).desiredState, "running");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "active");
    assert.equal(tenant.desiredState, "running");
  });

  it("never resurrects an already-deleted Cloud cell", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "active",
      initialDesiredState: "deleted",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    // No cell row was matched (the only row is already deleted), so there is
    // nothing to reconcile -- and the tenant mirror must not run either.
    assert.equal(target, null);
    assert.equal((await cellState(cellId)).desiredState, "deleted");
    assert.deepEqual(await tenantState(tenantId), {
      status: "provisioning",
      desiredState: "running",
      deletedAt: null,
    });
  });

  it("sweeps every active tenant, deleting past-window cancellations and leaving others alone", async () => {
    await resetFleet();
    // A `cancelledRetentionDays: 0` window with any past `sourceOccurredAt`
    // is already elapsed against the real wall clock, so this needs no Date
    // mocking -- unlike the single-tenant boundary tests above, which take an
    // explicit `now` because they test the boundary itself.
    const past = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: new Date(Date.now() - 60_000),
      initialDesiredState: "read_only",
    });
    const active = await seedTenant({ source: "paddle", sourceState: "active", initialDesiredState: "stopped" });

    const result = await runBoundedCloudReconcile({ cancelledRetentionDays: 0 });
    assert.equal(result.reconciled, 2);
    assert.equal(result.deleted, 1);
    assert.equal((await cellState(past.cellId)).desiredState, "deleted");
    assert.equal((await cellState(active.cellId)).desiredState, "running");
    const pastTenant = await tenantState(past.tenantId);
    assert.equal(pastTenant.status, "deleted");
    assert.equal(pastTenant.desiredState, "deleted");
    const activeTenant = await tenantState(active.tenantId);
    assert.equal(activeTenant.status, "active");
    assert.equal(activeTenant.desiredState, "running");
  });

  it("bounds the sweep to maxTenants", async () => {
    await resetFleet();
    await seedTenant({ source: "paddle", sourceState: "active", initialDesiredState: "stopped" });
    await seedTenant({ source: "paddle", sourceState: "active", initialDesiredState: "stopped" });
    await seedTenant({ source: "paddle", sourceState: "active", initialDesiredState: "stopped" });
    const result = await runBoundedCloudReconcile({ maxTenants: 2 });
    assert.equal(result.reconciled, 2);
  });

  // Security review finding 1 (BLOCKER): an unrecognised source_state
  // (pre-payment awaiting_checkout/checkout_pending) must never fall back to
  // an allow-read entitlement state. Before the fix, toSourceProjection
  // coerced this into "cancelled", which desiredCloudCellState maps to
  // read_only -- giving an unpaid tenant a live, readable cell.
  it("keeps a pre-payment (awaiting_checkout) tenant stopped on a direct reconcile, never read_only", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      initialDesiredState: "stopped",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "stopped");
    assert.equal((await cellState(cellId)).desiredState, "stopped");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "suspended");
    assert.equal(tenant.desiredState, "suspended");
  });

  it("keeps a checkout_pending tenant stopped on a direct reconcile too", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "checkout_pending",
      initialDesiredState: "stopped",
    });
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "stopped");
    assert.equal((await cellState(cellId)).desiredState, "stopped");
  });

  it("the sweep skips pre-payment tenants entirely, leaving their stopped cell untouched", async () => {
    await resetFleet();
    const prePayment = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      initialDesiredState: "stopped",
    });
    const paid = await seedTenant({
      source: "paddle",
      sourceState: "active",
      initialDesiredState: "stopped",
    });
    const result = await runBoundedCloudReconcile({ maxTenants: 200 });
    // Only the paid tenant is in the sweep's population.
    assert.equal(result.reconciled, 1);
    assert.equal((await cellState(prePayment.cellId)).desiredState, "stopped");
    assert.equal((await cellState(paid.cellId)).desiredState, "running");
  });

  it("clears a claimed cancellation notice when the cell returns to running", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: new Date(),
      initialDesiredState: "read_only",
    });
    await pool!.query(
      "UPDATE exomem_cloud_cells SET cancellation_notice_sent_at = now() WHERE cell_id = $1",
      [cellId]
    );
    await pool!.query("UPDATE exomem_entitlements SET source_state = 'active' WHERE tenant_id = $1", [
      tenantId,
    ]);
    const target = await reconcileCloudCellDesiredState(tenantId, { cancelledRetentionDays: 30 });
    assert.equal(target, "running");
    const { rows } = await pool!.query(
      "SELECT cancellation_notice_sent_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [cellId]
    );
    assert.equal(rows[0].cancellation_notice_sent_at, null);
  });

  it("returns null for a tenant with no Cloud cell row", async () => {
    await resetFleet();
    const userResult = await pool!.query(
      "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
      [`cloud-lifecycle-nocell-${randomUUID()}@example.test`]
    );
    const tenantResult = await pool!.query(
      "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
      [userResult.rows[0].id]
    );
    const tenantId = tenantResult.rows[0].id as string;
    await pool!.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state)
       VALUES ($1, 'paddle', 'active', 'active')`,
      [tenantId]
    );
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, null);
  });

  // Cloud design D2 "Deletion revokes consent" and the D4 account-deletion row.
  async function admitWithTokens(): Promise<{ tenantId: string; cellId: string }> {
    const fixture = await createCloudOAuthFixture();
    const codeDigest = randomBytes(32);
    const admission = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: fixture.inviteDigest,
      transactionDigest: fixture.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest,
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.ok(admission);
    const issued = await issueOAuthTokensFromCodeAtomic({
      codeDigest,
      clientId: fixture.clientId,
      redirectUri: fixture.redirectUri,
      resource: "https://cloud.example.test/mcp/v1",
      pkceChallenge: "challenge",
      refreshDigest: randomBytes(32),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      accessDigest: randomBytes(32),
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.ok(issued, "sanity: the admitted tenant holds live Cloud tokens");
    return { tenantId: admission!.tenantId, cellId: admission!.cellId };
  }

  async function liveConsent(tenantId: string): Promise<{ grants: number; families: number; tokens: number }> {
    const { rows } = await pool!.query(
      `SELECT
         (SELECT count(*)::int FROM exomem_oauth_grants
           WHERE tenant_id = $1 AND revoked_at IS NULL) AS grants,
         (SELECT count(*)::int FROM exomem_oauth_token_families AS family
           JOIN exomem_oauth_grants AS g ON g.id = family.grant_id
           WHERE g.tenant_id = $1 AND family.revoked_at IS NULL) AS families,
         (SELECT count(*)::int FROM exomem_oauth_access_tokens AS token
           JOIN exomem_oauth_grants AS g ON g.id = token.grant_id
           WHERE g.tenant_id = $1 AND token.revoked_at IS NULL) AS tokens`,
      [tenantId]
    );
    return rows[0] as { grants: number; families: number; tokens: number };
  }

  it("revokes Cloud grants, token families and access tokens in the transaction that deletes the cell", async () => {
    await resetFleet();
    await configureCapacity(2);
    const { tenantId, cellId } = await admitWithTokens();
    assert.deepEqual(await liveConsent(tenantId), { grants: 1, families: 1, tokens: 1 });
    await pool!.query(
      `UPDATE exomem_entitlements
       SET source = 'paddle', source_state = 'cancelled', source_occurred_at = '2026-01-01T00:00:00Z'
       WHERE tenant_id = $1`,
      [tenantId]
    );
    const target = await reconcileCloudCellDesiredState(tenantId, {
      cancelledRetentionDays: 30,
      now: new Date("2026-03-01T00:00:00Z"),
    });
    assert.equal(target, "deleted");
    assert.equal((await cellState(cellId)).desiredState, "deleted");
    assert.deepEqual(await liveConsent(tenantId), { grants: 0, families: 0, tokens: 0 });
  });

  it("deletes the Cloud cell of a confirmed account deletion, leaving the tenant deletion_pending for billing", async () => {
    await resetFleet();
    await configureCapacity(2);
    const { tenantId, cellId } = await admitWithTokens();
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [tenantId]
    );
    const target = await reconcileCloudCellDesiredState(tenantId);
    assert.equal(target, "deleted");
    assert.equal((await cellState(cellId)).desiredState, "deleted");
    const tenant = await tenantState(tenantId);
    assert.equal(tenant.status, "deletion_pending", "billing deletion keys on deletion_pending");
    assert.deepEqual(await liveConsent(tenantId), { grants: 0, families: 0, tokens: 0 });
  });

  // A deletion must not depend on configuration the control plane does not
  // otherwise need: with the Cloud env absent, deleting a cell still revokes
  // every grant the tenant holds.
  it("revokes consent and deletes the cell even when the Cloud configuration is absent", async () => {
    await resetFleet();
    await configureCapacity(2);
    const { tenantId, cellId } = await admitWithTokens();
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [tenantId]
    );
    const saved = { ...process.env };
    for (const key of Object.keys(CLOUD_CONFIG_ENV)) delete process.env[key];
    try {
      assert.equal(await reconcileCloudCellDesiredState(tenantId), "deleted");
    } finally {
      Object.assign(process.env, saved);
    }
    assert.equal((await cellState(cellId)).desiredState, "deleted");
    assert.deepEqual(await liveConsent(tenantId), { grants: 0, families: 0, tokens: 0 });
  });

  it("the sweep isolates a tenant whose reconcile throws, so every other tenant is still reconciled", async () => {
    await resetFleet();
    const cancelledAt = new Date("2026-01-01T00:00:00Z");
    const broken = await seedTenant({ source: "complimentary", sourceState: "complimentary_active" });
    const healthy = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      sourceOccurredAt: cancelledAt,
      initialDesiredState: "read_only",
    });
    const result = await runBoundedCloudReconcile({
      cancelledRetentionDays: 30,
      reconcileTenant: async (tenantId, options) => {
        if (tenantId === broken.tenantId) throw new Error("simulated one-tenant failure");
        return reconcileCloudCellDesiredState(tenantId, options);
      },
    });
    assert.equal((await cellState(healthy.cellId)).desiredState, "deleted");
    assert.equal(result.failed, 1);
  });

  it("the sweep deletes a pre-payment tenant's cell once its account deletion is confirmed", async () => {
    await resetFleet();
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      initialDesiredState: "stopped",
    });
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [tenantId]
    );
    await runBoundedCloudReconcile();
    assert.equal((await cellState(cellId)).desiredState, "deleted");
  });

  it("refuses an OAuth token exchange once the mirror drives a tenant to stopped, but not to read_only", async () => {
    await resetFleet();
    await configureCapacity(2);

    async function admitOneCloudTenant(): Promise<{
      tenantId: string;
      exchange: Parameters<typeof issueOAuthTokensFromCodeAtomic>[0];
    }> {
      const fixture = await createCloudOAuthFixture();
      const codeDigest = randomBytes(32);
      const admission = await admitFirstCloudOAuthInviteAtomic({
        inviteDigest: fixture.inviteDigest,
        transactionDigest: fixture.transactionDigest,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        codeDigest,
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.ok(admission);
      return {
        tenantId: admission!.tenantId,
        exchange: {
          codeDigest,
          clientId: fixture.clientId,
          redirectUri: fixture.redirectUri,
          resource: "https://cloud.example.test/mcp/v1",
          pkceChallenge: "challenge",
          refreshDigest: randomBytes(32),
          refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          accessDigest: randomBytes(32),
          accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      };
    }

    // Stopped: manually suspend a complimentary-admitted tenant's
    // entitlement, then reconcile -- deny/deny maps to "stopped" (D4), and
    // the tenant mirror now writes status='suspended', desired_state=
    // 'suspended'. oauth-store.ts's real, unmodified
    // issueOAuthTokensFromCodeAtomic gate (status IN ('provisioning',
    // 'active') AND desired_state = 'running') must refuse this code.
    const stopped = await admitOneCloudTenant();
    await pool!.query("UPDATE exomem_entitlements SET manual_suspended_at = now() WHERE tenant_id = $1", [
      stopped.tenantId,
    ]);
    const stoppedTarget = await reconcileCloudCellDesiredState(stopped.tenantId);
    assert.equal(stoppedTarget, "stopped");
    const stoppedTenant = await tenantState(stopped.tenantId);
    assert.equal(stoppedTenant.status, "suspended");
    assert.equal(stoppedTenant.desiredState, "suspended");
    const stoppedResult = await issueOAuthTokensFromCodeAtomic(stopped.exchange);
    assert.equal(stoppedResult, null, "a stopped Cloud tenant's code must not yield tokens");

    // read_only: a paddle subscription past_due after admission. The mirror
    // write is skipped (no CHECK-constraint-admitted value), so the tenant
    // stays at admission's own initial status='provisioning', desired_state=
    // 'running' -- both already inside the gate's allowed set -- so the cell
    // still serving reads must still get tokens.
    const readOnly = await admitOneCloudTenant();
    await pool!.query(
      "UPDATE exomem_entitlements SET source = 'paddle', source_state = 'past_due' WHERE tenant_id = $1",
      [readOnly.tenantId]
    );
    const readOnlyTarget = await reconcileCloudCellDesiredState(readOnly.tenantId);
    assert.equal(readOnlyTarget, "read_only");
    const readOnlyTenant = await tenantState(readOnly.tenantId);
    assert.equal(readOnlyTenant.status, "provisioning");
    assert.equal(readOnlyTenant.desiredState, "running");
    const readOnlyResult = await issueOAuthTokensFromCodeAtomic(readOnly.exchange);
    assert.ok(readOnlyResult, "a read_only Cloud tenant's code must still yield tokens");
  });
});
