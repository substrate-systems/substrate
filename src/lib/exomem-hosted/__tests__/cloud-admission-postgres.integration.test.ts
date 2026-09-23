import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  admitFirstCloudOAuthInviteAtomic,
  expireCloudAwaitingCheckoutTenants,
  randomCloudCellId,
  redeemCloudInviteAtomic,
} from "../cloud-admission";
import { reconcileCloudCellDesiredState } from "../cloud-lifecycle";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import type { ExomemPaddleConfig } from "../paddle-config";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Task 3.3/3.4: Cloud admission (design D1) against real PostgreSQL.

// The expiry path's Paddle config is injected directly so these tests need
// no real PADDLE_ENVIRONMENT/PADDLE_API_KEY — the fake cancelTransaction
// dependency below never actually reads apiBaseUrl/apiKey either way.
const FAKE_PADDLE_CONFIG: ExomemPaddleConfig = {
  environment: "sandbox",
  apiBaseUrl: "https://sandbox-api.paddle.test",
  productKey: "exomem-hosted",
  productId: null,
  priceId: null,
  checkoutUrl: null,
  apiKey: "fake-test-key",
  webhookSecret: null,
  clientToken: null,
  clientEnvironment: null,
  paidCheckoutEnabled: false,
};

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

async function configureCapacity(slots: number): Promise<void> {
  await pool!.query("DELETE FROM exomem_cloud_capacity");
  await pool!.query(
    "INSERT INTO exomem_cloud_capacity (node, cell_slots) VALUES ($1, $2)",
    [`node-${randomUUID()}`, slots]
  );
}

// Tests share one schema across the whole file (creating a fresh schema per
// test would cost a full migration run each time), so admission state from a
// prior test — cells, entitlements, sessions, invites, tenants, users — must
// not leak into the capacity arithmetic of the next one.
async function resetFleet(): Promise<void> {
  // OAuth admission fixtures first — codes reference grants, grants
  // reference tenants/sessions, so they must go before those tables clear.
  await pool!.query("DELETE FROM exomem_oauth_authorization_codes");
  await pool!.query("DELETE FROM exomem_oauth_grants");
  await pool!.query("DELETE FROM exomem_oauth_authorization_transactions");
  await pool!.query("DELETE FROM exomem_oauth_clients");
  // Invites first: exomem_invites.redeemed_session_id is ON DELETE SET NULL,
  // and setting only that column null while consumed_at/consumed_by/
  // redeemed_tenant_id stay non-null would itself violate the invite's
  // all-or-nothing consumption check — so the invite row must go before the
  // session it points at, not after.
  await pool!.query("DELETE FROM exomem_invites");
  await pool!.query("DELETE FROM exomem_sessions");
  await pool!.query("DELETE FROM exomem_entitlements");
  await pool!.query("DELETE FROM exomem_cloud_cells");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM users");
}

async function createInvite(
  source: "complimentary" | "paddle",
  email = `cloud-admit-${randomUUID()}@example.test`
): Promise<{ tokenDigest: Buffer; email: string }> {
  const tokenDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, $3, '["capture","recall"]'::jsonb, '{}'::jsonb, $4, now() + interval '1 day')`,
    [tokenDigest, email, source, randomBytes(32)]
  );
  return { tokenDigest, email };
}

async function createCloudOAuthFixture(
  email = `cloud-oauth-admit-${randomUUID()}@example.test`
): Promise<{
  inviteDigest: Buffer;
  transactionDigest: Buffer;
}> {
  const clientId = `https://cloud-oauth-fixture-${randomUUID()}.example.test/client.json`;
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
    [inviteDigest, email, randomBytes(32)]
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

  return { inviteDigest, transactionDigest };
}

function redemptionInput(tokenDigest: Buffer) {
  return {
    tokenDigest,
    sessionDigest: randomBytes(32),
    csrfDigest: randomBytes(32),
    sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

// admitFirstCloudOAuthInviteAtomic loads the Cloud resource URL (security
// review finding 15: it asserts the pending authorization transaction is
// bound to exactly this resource) via loadExomemCloudConfig(), which reads
// real process.env -- these tests need the three required vars present for
// the whole suite, restored afterwards so they don't leak into other files.
const CLOUD_CONFIG_ENV = {
  EXOMEM_CLOUD_MCP_URL: "https://cloud.example.test/mcp/v1",
  EXOMEM_CLOUD_MCP_PATH: "/api/exomem/cloud/mcp/v1",
  EXOMEM_CLOUD_CELL_TOKEN_KEY: "a".repeat(64),
} as const;
const priorCloudConfigEnv: Partial<Record<keyof typeof CLOUD_CONFIG_ENV, string | undefined>> = {};

describe("Exomem Cloud admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const key of Object.keys(CLOUD_CONFIG_ENV) as Array<keyof typeof CLOUD_CONFIG_ENV>) {
      priorCloudConfigEnv[key] = process.env[key];
      process.env[key] = CLOUD_CONFIG_ENV[key];
    }
    schema = `cloud_admit_it_${randomUUID().replaceAll("-", "")}`;
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

  it("admits the first complimentary invite on an empty fleet with desired_state running", async () => {
    await resetFleet();
    await configureCapacity(1);
    const invite = await createInvite("complimentary");
    const result = await redeemCloudInviteAtomic(redemptionInput(invite.tokenDigest));
    assert.ok(result);
    const cell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [result!.cellId]
    );
    assert.equal(cell.rows[0]!.desired_state, "running");
    const consumed = await pool!.query("SELECT consumed_at FROM exomem_invites WHERE token_digest = $1", [
      invite.tokenDigest,
    ]);
    assert.notEqual(consumed.rows[0]!.consumed_at, null);
  });

  it("refuses admission when capacity is exhausted and leaves the invite unconsumed", async () => {
    await resetFleet();
    await configureCapacity(1);
    const first = await createInvite("complimentary");
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);

    const second = await createInvite("complimentary");
    await assert.rejects(
      redeemCloudInviteAtomic(redemptionInput(second.tokenDigest)),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error);
        assert.equal((error as { code: string }).code, "HOSTED_ADMISSION_CLOSED");
        return true;
      }
    );
    const invite = await pool!.query(
      "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
      [second.tokenDigest]
    );
    assert.equal(invite.rows[0]!.consumed_at, null);
  });

  it("admits exactly one of two concurrent redemptions at the last free slot", async () => {
    await resetFleet();
    await configureCapacity(1);
    const first = await createInvite("complimentary");
    const second = await createInvite("complimentary");

    const results = await Promise.allSettled([
      redeemCloudInviteAtomic(redemptionInput(first.tokenDigest)),
      redeemCloudInviteAtomic(redemptionInput(second.tokenDigest)),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof redeemCloudInviteAtomic>>
    >[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0]!.reason as { code?: string }).code, "HOSTED_ADMISSION_CLOSED");

    const activeCells = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_cloud_cells WHERE desired_state <> 'deleted'"
    );
    assert.equal(activeCells.rows[0]!.n, 1);
  });

  // Security review finding 4: a tenant whose only Cloud cell has been fully
  // deleted (the day-30 export window elapsed, or a manual release) is not
  // permanently unable to redeem another invite. redeemCloudInviteAtomic's
  // owner dedupe now only rejects an owner with a LIVE (non-deleted) cell --
  // a cell-less owner is reused, going through the exact same capacity
  // check as a first-time redemption, and gets a genuinely new cell row.
  it("re-admits a tenant whose only Cloud cell was deleted, via a new invite, same capacity check, new cell row", async () => {
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-readmit-${randomUUID()}@example.test`;

    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);

    // Simulate the day-30 export-window sweep (or a manual release) fully
    // deleting the cell: exactly the state reconcileCloudCellDesiredState
    // leaves behind, and exactly what has_live_cell in the dedupe check
    // tests for.
    await pool!.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1",
      [admitted!.cellId]
    );
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [admitted!.tenantId]
    );

    // A fresh invite for the same owner: same capacity (still 1 slot, and
    // the deleted cell no longer counts as used), so this must succeed, not
    // hit HOSTED_ADMISSION_CLOSED and not hit the "already has a tenant"
    // dedupe rejection either.
    const second = await createInvite("complimentary", email);
    const readmitted = await redeemCloudInviteAtomic(redemptionInput(second.tokenDigest));
    assert.ok(readmitted);
    assert.equal(readmitted!.tenantId, admitted!.tenantId, "reuses the same tenant row, not a duplicate");
    assert.notEqual(readmitted!.cellId, admitted!.cellId, "gets a genuinely new cell row");

    const tenant = await pool!.query(
      "SELECT status, desired_state, deleted_at FROM exomem_tenants WHERE id = $1",
      [admitted!.tenantId]
    );
    assert.equal(tenant.rows[0]!.status, "provisioning");
    assert.equal(tenant.rows[0]!.desired_state, "running");
    assert.equal(tenant.rows[0]!.deleted_at, null, "admission columns reset, not inherited from the deleted prior cell");

    const cell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [readmitted!.cellId]
    );
    assert.equal(cell.rows[0]!.desired_state, "running");

    const activeCells = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_cloud_cells WHERE desired_state <> 'deleted'"
    );
    assert.equal(activeCells.rows[0]!.n, 1, "capacity still reflects exactly one live cell, not two");
  });

  it("still refuses re-admission while the owner's prior cell is still live", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-readmit-live-${randomUUID()}@example.test`;

    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);

    const second = await createInvite("complimentary", email);
    await assert.rejects(redeemCloudInviteAtomic(redemptionInput(second.tokenDigest)));
    const invite = await pool!.query(
      "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
      [second.tokenDigest]
    );
    assert.equal(invite.rows[0]!.consumed_at, null);
  });

  // Cloud design D1 "Re-admission scope": re-admission applies only to a
  // `deleted` tenant or a pre-payment one. A tenant whose deletion or billing
  // is still in flight is never re-admitted, and its invite stays unconsumed.
  async function admitThenDeleteCell(email: string): Promise<{ tenantId: string; cellId: string }> {
    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1", [
      admitted!.cellId,
    ]);
    return { tenantId: admitted!.tenantId, cellId: admitted!.cellId };
  }

  async function assertRefusedAndUnconsumed(email: string): Promise<void> {
    const invite = await createInvite("complimentary", email);
    // A clean refusal, not an incidental constraint violation further on.
    await assert.rejects(redeemCloudInviteAtomic(redemptionInput(invite.tokenDigest)), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ACCESS_TOKEN_INVALID");
      return true;
    });
    const row = await pool!.query("SELECT consumed_at FROM exomem_invites WHERE token_digest = $1", [
      invite.tokenDigest,
    ]);
    assert.equal(row.rows[0]!.consumed_at, null);
  }

  it("refuses re-admission for a tenant whose deletion is still pending", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-readmit-pending-${randomUUID()}@example.test`;
    const { tenantId } = await admitThenDeleteCell(email);
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [tenantId]
    );
    await assertRefusedAndUnconsumed(email);
  });

  it("refuses re-admission for a tenant that still has a live provider subscription", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-readmit-subscribed-${randomUUID()}@example.test`;
    const { tenantId } = await admitThenDeleteCell(email);
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [tenantId]
    );
    await pool!.query(
      `UPDATE exomem_entitlements
       SET source = 'paddle', source_state = 'active', provider_subscription_ref = 'sub_live',
           provider_environment = 'sandbox'
       WHERE tenant_id = $1`,
      [tenantId]
    );
    await assertRefusedAndUnconsumed(email);
  });

  it("re-admits an expired pre-payment tenant and resets every provider field", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-readmit-unpaid-${randomUUID()}@example.test`;
    const { tenantId } = await admitThenDeleteCell(email);
    // The 7-day expiry leaves the tenant `provisioning` with an
    // awaiting_checkout entitlement and a cancelled checkout on record.
    await pool!.query(
      `UPDATE exomem_entitlements
       SET source = 'paddle', source_state = 'awaiting_checkout',
           provider_transaction_ref = 'txn_cancelled', provider_environment = 'sandbox'
       WHERE tenant_id = $1`,
      [tenantId]
    );
    const invite = await createInvite("complimentary", email);
    const readmitted = await redeemCloudInviteAtomic(redemptionInput(invite.tokenDigest));
    assert.ok(readmitted);
    assert.equal(readmitted!.tenantId, tenantId);
    const entitlement = await pool!.query(
      "SELECT provider_environment, provider_transaction_ref FROM exomem_entitlements WHERE tenant_id = $1",
      [tenantId]
    );
    assert.equal(entitlement.rows[0]!.provider_environment, null);
    assert.equal(entitlement.rows[0]!.provider_transaction_ref, null);
  });

  it("refuses Cloud OAuth re-admission for a tenant whose deletion is still pending", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-oauth-readmit-pending-${randomUUID()}@example.test`;
    const { tenantId } = await admitThenDeleteCell(email);
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [tenantId]
    );
    const fixture = await createCloudOAuthFixture(email);
    const result = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: fixture.inviteDigest,
      transactionDigest: fixture.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.equal(result, null);
    const invite = await pool!.query("SELECT consumed_at FROM exomem_invites WHERE token_digest = $1", [
      fixture.inviteDigest,
    ]);
    assert.equal(invite.rows[0]!.consumed_at, null);
  });

  it("starts a paid invite stopped and activates it with no second capacity check, even on a full fleet", async () => {
    await resetFleet();
    await configureCapacity(1);
    const paid = await createInvite("paddle");
    const result = await redeemCloudInviteAtomic(redemptionInput(paid.tokenDigest));
    assert.ok(result);
    const stoppedCell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [result!.cellId]
    );
    assert.equal(stoppedCell.rows[0]!.desired_state, "stopped");

    // The fleet is now "full" (one non-deleted row against a capacity of 1),
    // yet activation must still succeed — no second capacity check.
    // Checkout completing is simulated the way the real Paddle webhook hook
    // now does it (security review finding 13 removed the separate
    // activateCloudCellOnCheckoutAtomic call/function): the entitlement's
    // source_state moves to 'active', and reconcileCloudCellDesiredState
    // (D4) maps that straight to running.
    await pool!.query(
      "UPDATE exomem_entitlements SET source_state = 'active', effective_state = 'active' WHERE tenant_id = $1",
      [result!.tenantId]
    );
    const target = await reconcileCloudCellDesiredState(result!.tenantId);
    assert.equal(target, "running");
    const runningCell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [result!.cellId]
    );
    assert.equal(runningCell.rows[0]!.desired_state, "running");
  });

  it("expires an unpaid invite after 7 days by cancelling its transaction and deleting the row", async () => {
    await resetFleet();
    await configureCapacity(2);
    const paid = await createInvite("paddle");
    const result = await redeemCloudInviteAtomic(redemptionInput(paid.tokenDigest));
    assert.ok(result);
    await pool!.query(
      `UPDATE exomem_entitlements
       SET provider_transaction_ref = 'txn_expiretest0000000000000',
           provider_environment = 'sandbox'
       WHERE tenant_id = $1`,
      [result!.tenantId]
    );
    await pool!.query("UPDATE exomem_tenants SET created_at = now() - interval '8 days' WHERE id = $1", [
      result!.tenantId,
    ]);

    let cancelCalls = 0;
    const outcomes = await expireCloudAwaitingCheckoutTenants({
      config: FAKE_PADDLE_CONFIG,
      cancelTransaction: async () => {
        cancelCalls += 1;
        return { state: "canceled" };
      },
    });
    assert.equal(cancelCalls, 1);
    assert.deepEqual(
      outcomes.map((o) => o.outcome),
      ["expired"]
    );
    const cell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [result!.cellId]
    );
    assert.equal(cell.rows[0]!.desired_state, "deleted");
  });

  // Cloud design D2 "Deletion revokes consent": the unpaid-invite expiry that
  // deletes the cell also revokes the tenant's Cloud grants.
  it("revokes the tenant's Cloud consent when the unpaid-invite expiry deletes its cell", async () => {
    await resetFleet();
    await configureCapacity(2);
    const fixture = await createCloudOAuthFixture();
    const admission = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: fixture.inviteDigest,
      transactionDigest: fixture.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.ok(admission);
    // Recast as an unpaid invite past its 7-day window, with no checkout.
    await pool!.query(
      "UPDATE exomem_entitlements SET source = 'paddle', source_state = 'awaiting_checkout' WHERE tenant_id = $1",
      [admission!.tenantId]
    );
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'stopped' WHERE cell_id = $1", [
      admission!.cellId,
    ]);
    await pool!.query("UPDATE exomem_tenants SET created_at = now() - interval '8 days' WHERE id = $1", [
      admission!.tenantId,
    ]);
    const live = () =>
      pool!.query("SELECT count(*)::int AS n FROM exomem_oauth_grants WHERE tenant_id = $1 AND revoked_at IS NULL", [
        admission!.tenantId,
      ]);
    assert.equal((await live()).rows[0]!.n, 1, "sanity: admission created a live Cloud grant");

    const outcomes = await expireCloudAwaitingCheckoutTenants({ config: FAKE_PADDLE_CONFIG });
    assert.deepEqual(
      outcomes.map((o) => o.outcome),
      ["expired"]
    );
    assert.equal((await live()).rows[0]!.n, 0);
  });

  it("leaves the row for activation when the provider reports the transaction already completed", async () => {
    await resetFleet();
    await configureCapacity(2);
    const paid = await createInvite("paddle");
    const result = await redeemCloudInviteAtomic(redemptionInput(paid.tokenDigest));
    assert.ok(result);
    await pool!.query(
      `UPDATE exomem_entitlements
       SET provider_transaction_ref = 'txn_completetest00000000000',
           provider_environment = 'sandbox'
       WHERE tenant_id = $1`,
      [result!.tenantId]
    );
    await pool!.query("UPDATE exomem_tenants SET created_at = now() - interval '8 days' WHERE id = $1", [
      result!.tenantId,
    ]);

    const outcomes = await expireCloudAwaitingCheckoutTenants({
      config: FAKE_PADDLE_CONFIG,
      cancelTransaction: async () => ({
        state: "completed",
        customerId: "ctm_x",
        subscriptionId: "sub_x",
      }),
    });
    assert.deepEqual(
      outcomes.map((o) => o.outcome),
      ["skipped"]
    );
    const cell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [result!.cellId]
    );
    // Not deleted — left stopped for the ordinary activation webhook.
    assert.equal(cell.rows[0]!.desired_state, "stopped");
  });

  it("admits a first Cloud OAuth invite: creates the cell, session, grant and code, and consumes both", async () => {
    await resetFleet();
    await configureCapacity(1);
    const fixture = await createCloudOAuthFixture();
    const result = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: fixture.inviteDigest,
      transactionDigest: fixture.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.ok(result);
    assert.equal(result!.cellId.length, 16);

    const cell = await pool!.query(
      "SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1",
      [result!.cellId]
    );
    assert.equal(cell.rows[0]!.desired_state, "running");

    const invite = await pool!.query(
      "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
      [fixture.inviteDigest]
    );
    assert.notEqual(invite.rows[0]!.consumed_at, null);

    const transaction = await pool!.query(
      "SELECT consumed_at FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1",
      [fixture.transactionDigest]
    );
    assert.notEqual(transaction.rows[0]!.consumed_at, null);

    const grant = await pool!.query("SELECT id FROM exomem_oauth_grants WHERE id = $1", [
      result!.grantId,
    ]);
    assert.ok(grant.rows[0]);

    const code = await pool!.query(
      "SELECT id FROM exomem_oauth_authorization_codes WHERE grant_id = $1",
      [result!.grantId]
    );
    assert.equal(code.rows.length, 1);
  });

  // Security review finding 4, OAuth admission's own copy of the
  // redeemCloudInviteAtomic re-admission fix: exomem_entitlements.tenant_id
  // is UNIQUE, so re-admitting a cell-less tenant through a fresh OAuth
  // invite must not collide with the row its prior admission left behind.
  it("re-admits a tenant whose only Cloud cell was deleted, through a fresh OAuth invite", async () => {
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-oauth-readmit-${randomUUID()}@example.test`;

    const first = await createCloudOAuthFixture(email);
    const admitted = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: first.inviteDigest,
      transactionDigest: first.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.ok(admitted);

    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1", [
      admitted!.cellId,
    ]);
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [admitted!.tenantId]
    );

    const second = await createCloudOAuthFixture(email);
    const readmitted = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: second.inviteDigest,
      transactionDigest: second.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.ok(readmitted);
    assert.equal(readmitted!.tenantId, admitted!.tenantId);
    assert.notEqual(readmitted!.cellId, admitted!.cellId);
  });

  it("refuses Cloud OAuth admission when capacity is exhausted, leaving the invite and transaction unconsumed", async () => {
    await resetFleet();
    await configureCapacity(1);
    const first = await createInvite("complimentary");
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);

    const fixture = await createCloudOAuthFixture();
    await assert.rejects(
      admitFirstCloudOAuthInviteAtomic({
        inviteDigest: fixture.inviteDigest,
        transactionDigest: fixture.transactionDigest,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        codeDigest: randomBytes(32),
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      }),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error);
        assert.equal((error as { code: string }).code, "HOSTED_ADMISSION_CLOSED");
        return true;
      }
    );

    const invite = await pool!.query(
      "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
      [fixture.inviteDigest]
    );
    assert.equal(invite.rows[0]!.consumed_at, null);
    const transaction = await pool!.query(
      "SELECT consumed_at FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1",
      [fixture.transactionDigest]
    );
    assert.equal(transaction.rows[0]!.consumed_at, null);
  });

  it("refuses Cloud OAuth admission for an unknown invite", async () => {
    await resetFleet();
    await configureCapacity(2);
    const fixture = await createCloudOAuthFixture();
    const result = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: randomBytes(32),
      transactionDigest: fixture.transactionDigest,
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.equal(result, null);
  });

  it("refuses Cloud OAuth admission for an unknown or already-consumed transaction", async () => {
    await resetFleet();
    await configureCapacity(2);
    const invite = await createInvite("complimentary");
    const result = await admitFirstCloudOAuthInviteAtomic({
      inviteDigest: invite.tokenDigest,
      transactionDigest: randomBytes(32),
      sessionDigest: randomBytes(32),
      csrfDigest: randomBytes(32),
      sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      codeDigest: randomBytes(32),
      codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.equal(result, null);
    // The invite is untouched too — it must not be silently spent by a
    // rejected transaction lookup.
    const inviteRow = await pool!.query(
      "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
      [invite.tokenDigest]
    );
    assert.equal(inviteRow.rows[0]!.consumed_at, null);
  });

  it("randomCloudCellId produces the 16-character lowercase base32 shape the cell_id CHECK requires", () => {
    const id = randomCloudCellId();
    assert.match(id, /^[a-z2-7]{16}$/);
  });
});
