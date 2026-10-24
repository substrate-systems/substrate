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
import {
  createOAuthContinuation,
  liveOAuthConsentPath,
  oauthConsentPath,
} from "../oauth-continuity";
import { attachExistingOwnerAuthorizationAtomic } from "../oauth-store";
import { tokenDigest } from "../security";
import type { PaddleTransport } from "../paddle-billing";
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
  friendPriceId: null,
  friendDiscountId: null,
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
    "INSERT INTO exomem_cloud_capacity (node, cell_slots, observed_at) VALUES ($1, $2, now())",
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
  // Account blocks reference tenants with ON DELETE RESTRICT.
  await pool!.query("DELETE FROM exomem_oauth_account_blocks");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM exomem_users");
  await pool!.query("DELETE FROM users");
}

async function createInvite(
  source: "complimentary" | "paddle",
  email = `cloud-admit-${randomUUID()}@example.test`,
  purpose = false
): Promise<{ tokenDigest: Buffer; email: string }> {
  const tokenDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at, marketplace_reviewer_purpose
     ) VALUES ($1, $2, $3, '["capture","recall"]'::jsonb, '{}'::jsonb, $4, now() + interval '1 day', $5)`,
    [tokenDigest, email, source, randomBytes(32), purpose]
  );
  return { tokenDigest, email };
}

async function createCloudOAuthFixture(
  email = `cloud-oauth-admit-${randomUUID()}@example.test`,
  purpose = false,
  source: "complimentary" | "paddle" = "complimentary"
): Promise<{
  inviteDigest: Buffer;
  transactionDigest: Buffer;
  clientId: string;
  redirectUri: string;
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
       entitlement_limits, created_by_principal_digest, expires_at, marketplace_reviewer_purpose
     ) VALUES ($1, $2, $3, '["capture","recall"]'::jsonb, '{}'::jsonb, $4, now() + interval '1 day', $5)`,
    [inviteDigest, email, source, randomBytes(32), purpose]
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

  return { inviteDigest, transactionDigest, clientId, redirectUri: redirectUris[0]! };
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
// bound to exactly this resource) from real process.env -- these tests set
// the resource vars for the whole suite, restored afterwards so they don't
// leak into other files. The cell token key is deliberately unset: admission
// runs on Vercel, and design C4 gives that key to the gateway and cellctl only.
const CLOUD_CONFIG_ENV = {
  EXOMEM_CLOUD_MCP_URL: "https://cloud.example.test/mcp/v1",
  EXOMEM_CLOUD_MCP_PATH: "/api/exomem/cloud/mcp/v1",
  EXOMEM_CLOUD_CELL_TOKEN_KEY: undefined,
  // A paid admission enqueues its encrypted hold reminder.
  EXOMEM_CONTROL_PLANE_KEY: randomBytes(32).toString("base64url"),
} as const;
const priorCloudConfigEnv: Partial<Record<keyof typeof CLOUD_CONFIG_ENV, string | undefined>> = {};

describe("Exomem Cloud admission PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    for (const key of Object.keys(CLOUD_CONFIG_ENV) as Array<keyof typeof CLOUD_CONFIG_ENV>) {
      priorCloudConfigEnv[key] = process.env[key];
      const value = CLOUD_CONFIG_ENV[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

  for (const oauth of [false, true]) {
    it(`keeps canonical identity and shared-product identity separate through ${oauth ? "OAuth" : "browser"} admission`, async () => {
      await resetFleet();
      await configureCapacity(3);
      const oldAddress = `old-${randomUUID()}@example.test`;
      const newAddress = `new-${randomUUID()}@example.test`;
      const owner = await pool!.query(
        "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING *",
        [oldAddress]
      );
      const otherProductOwner = await pool!.query(
        "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING *",
        [newAddress]
      );
      const userId = owner.rows[0]!.id;
      await pool!.query(
        `INSERT INTO exomem_users (id, email, email_verified_at, created_at)
         SELECT id, $2, email_verified_at, created_at FROM users WHERE id = $1`,
        [userId, newAddress]
      );
      const admit = async (email: string) => {
        const fixture = oauth
          ? await createCloudOAuthFixture(email)
          : await createInvite("complimentary", email);
        const digest = "inviteDigest" in fixture ? fixture.inviteDigest : fixture.tokenDigest;
        const input = redemptionInput(digest);
        return oauth
          ? admitFirstCloudOAuthInviteAtomic({
              ...input,
              inviteDigest: digest,
              transactionDigest: (fixture as { transactionDigest: Buffer }).transactionDigest,
              codeDigest: randomBytes(32),
              codeExpiresAt: new Date(Date.now() + 60_000),
            })
          : redeemCloudInviteAtomic(input);
      };

      const fresh = await admit(oldAddress);
      assert.ok(fresh);
      assert.notEqual((await pool!.query("SELECT owner_user_id FROM exomem_tenants WHERE id = $1", [fresh.tenantId])).rows[0]!.owner_user_id, userId);
      const admitted = await admit(newAddress);
      assert.ok(admitted);
      const admittedOwner = await pool!.query(
        "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
        [admitted.tenantId]
      );
      assert.equal(admittedOwner.rows[0]!.owner_user_id, userId);
      const shared = await pool!.query("SELECT * FROM users ORDER BY email");
      assert.deepEqual(
        shared.rows,
        [...owner.rows, ...otherProductOwner.rows].sort((a, b) => a.email.localeCompare(b.email))
      );
      assert.equal((await pool!.query("SELECT email FROM exomem_users WHERE id = $1", [userId])).rows[0]!.email, newAddress);
      assert.equal((await pool!.query("SELECT count(*)::int AS n FROM exomem_users")).rows[0]!.n, 2);
    });

    it(`creates an independent identity without changing an existing shared address through ${oauth ? "OAuth" : "browser"} admission`, async () => {
      await resetFleet();
      await configureCapacity(2);
      const email = `shared-${randomUUID()}@example.test`;
      const shared = await pool!.query("INSERT INTO users (email) VALUES ($1) RETURNING *", [email]);
      const fixture = oauth
        ? await createCloudOAuthFixture(email)
        : await createInvite("complimentary", email);
      const digest = "inviteDigest" in fixture ? fixture.inviteDigest : fixture.tokenDigest;
      const input = redemptionInput(digest);
      const admitted = oauth
        ? await admitFirstCloudOAuthInviteAtomic({
            ...input,
            inviteDigest: digest,
            transactionDigest: (fixture as { transactionDigest: Buffer }).transactionDigest,
            codeDigest: randomBytes(32),
            codeExpiresAt: new Date(Date.now() + 60_000),
          })
        : await redeemCloudInviteAtomic(input);
      assert.ok(admitted);
      const admittedOwner = await pool!.query(
        "SELECT owner_user_id FROM exomem_tenants WHERE id = $1",
        [admitted.tenantId]
      );
      assert.notEqual(admittedOwner.rows[0]!.owner_user_id, shared.rows[0]!.id);
      const identity = await pool!.query("SELECT id, email, email_verified_at FROM exomem_users");
      assert.equal(identity.rows[0]!.id, admittedOwner.rows[0]!.owner_user_id);
      assert.equal(identity.rows[0]!.email, email);
      assert.ok(identity.rows[0]!.email_verified_at);
      assert.deepEqual((await pool!.query("SELECT * FROM users")).rows, shared.rows);

    });
  }

  for (const oauth of [false, true]) {
    for (const observation of [
      { name: "stale", value: "now() - interval '6 minutes'" },
      { name: "future-dated", value: "now() + interval '1 hour'" },
      { name: "missing", value: "NULL" },
    ]) {
      it(`preserves the invite while capacity is ${observation.name} and admits after refresh through ${oauth ? "OAuth" : "browser"}`, async () => {
        await resetFleet();
        await configureCapacity(1);
        await pool!.query(
          `UPDATE exomem_cloud_capacity SET observed_at = ${observation.value}`
        );
        const fixture = oauth ? await createCloudOAuthFixture() : await createInvite("complimentary");
        const digest = "inviteDigest" in fixture ? fixture.inviteDigest : fixture.tokenDigest;
        const input = redemptionInput(digest);
        const admit = () =>
          oauth
            ? admitFirstCloudOAuthInviteAtomic({
                inviteDigest: digest,
                transactionDigest: (fixture as { transactionDigest: Buffer }).transactionDigest,
                ...input,
                codeDigest: randomBytes(32),
                codeExpiresAt: new Date(Date.now() + 60_000),
              })
            : redeemCloudInviteAtomic(input);

        await assert.rejects(admit(), (error: unknown) => {
          assert.ok(error && typeof error === "object" && "code" in error);
          assert.equal((error as { code: string }).code, "HOSTED_ADMISSION_CLOSED");
          return true;
        });
        const invite = await pool!.query(
          "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
          [digest]
        );
        assert.equal(invite.rows[0]!.consumed_at, null);
        const cells = await pool!.query("SELECT COUNT(*)::int AS count FROM exomem_cloud_cells");
        assert.equal(cells.rows[0]!.count, 0);
        if (oauth) {
          const transaction = await pool!.query(
            "SELECT consumed_at FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1",
            [(fixture as { transactionDigest: Buffer }).transactionDigest]
          );
          assert.equal(transaction.rows[0]!.consumed_at, null);
        }

        await pool!.query("UPDATE exomem_cloud_capacity SET observed_at = now()");
        assert.ok(await admit());
      });
    }

    for (const purpose of [false, true]) {
      it(`preserves sample purpose ${purpose} through ${oauth ? "OAuth" : "browser"} admission`, async () => {
        await resetFleet();
        await configureCapacity(5);
        const fixture = oauth
          ? await createCloudOAuthFixture(undefined, purpose)
          : await createInvite("complimentary", undefined, purpose);
        const digest = "inviteDigest" in fixture ? fixture.inviteDigest : fixture.tokenDigest;
        const result = oauth
          ? await admitFirstCloudOAuthInviteAtomic({
              inviteDigest: digest,
              transactionDigest: (fixture as { transactionDigest: Buffer }).transactionDigest,
              ...redemptionInput(digest),
              codeDigest: randomBytes(32),
              codeExpiresAt: new Date(Date.now() + 60_000),
            })
          : await redeemCloudInviteAtomic(redemptionInput(digest));
        assert.ok(result);
        const tenant = await pool!.query(
          "SELECT marketplace_reviewer_purpose FROM exomem_tenants WHERE id = $1",
          [result.tenantId]
        );
        assert.equal(tenant.rows[0].marketplace_reviewer_purpose, purpose);
      });

      it(`refuses sample purpose mismatch ${purpose} through ${oauth ? "OAuth" : "browser"} re-admission`, async () => {
        await resetFleet();
        await configureCapacity(5);
        const email = `purpose-${randomUUID()}@example.test`;
        const user = await pool!.query("INSERT INTO exomem_users (email) VALUES ($1) RETURNING id", [
          email,
        ]);
        await pool!.query(
          "INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose) VALUES ($1, 'provisioning', 'running', $2)",
          [user.rows[0].id, !purpose]
        );
        const fixture = oauth
          ? await createCloudOAuthFixture(email, purpose)
          : await createInvite("complimentary", email, purpose);
        const digest = "inviteDigest" in fixture ? fixture.inviteDigest : fixture.tokenDigest;
        if (oauth) {
          assert.equal(
            await admitFirstCloudOAuthInviteAtomic({
              inviteDigest: digest,
              transactionDigest: (fixture as { transactionDigest: Buffer }).transactionDigest,
              ...redemptionInput(digest),
              codeDigest: randomBytes(32),
              codeExpiresAt: new Date(Date.now() + 60_000),
            }),
            null
          );
        } else {
          await assert.rejects(redeemCloudInviteAtomic(redemptionInput(digest)));
        }
        const invites = await pool!.query(
          "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
          [digest]
        );
        assert.equal(invites.rows[0].consumed_at, null);
      });
    }
  }

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

  it("retains a deleting cell until cleanup is observed at its current generation", async () => {
    await resetFleet();
    await configureCapacity(1);
    const first = await createInvite("complimentary");
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted' WHERE cell_id = $1", [admitted.cellId]);
    const second = await createInvite("complimentary");
    const retry = () => redeemCloudInviteAtomic(redemptionInput(second.tokenDigest));
    const closed = (error: unknown) => (error as { code?: string }).code === "HOSTED_ADMISSION_CLOSED";
    await assert.rejects(retry(), closed);
    await pool!.query("UPDATE exomem_cloud_cells SET observed_state = 'deleted', observed_generation = generation - 1 WHERE cell_id = $1", [admitted.cellId]);
    await assert.rejects(retry(), closed);
    const invite = await pool!.query("SELECT consumed_at FROM exomem_invites WHERE token_digest = $1", [second.tokenDigest]);
    assert.equal(invite.rows[0]!.consumed_at, null);
    await pool!.query("UPDATE exomem_cloud_cells SET observed_generation = generation WHERE cell_id = $1", [admitted.cellId]);
    assert.ok(await retry());
  });

  it("keeps one identity and one tenant when two invitations for the same address redeem together", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `concurrent-${randomUUID()}@example.test`;
    const first = await createInvite("complimentary", email);
    const second = await createInvite("complimentary", email);
    const results = await Promise.allSettled([
      redeemCloudInviteAtomic(redemptionInput(first.tokenDigest)),
      redeemCloudInviteAtomic(redemptionInput(second.tokenDigest)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled" && result.value).length, 1);
    const owners = await pool!.query(
      `SELECT identity.id, tenant.owner_user_id
       FROM exomem_users AS identity
       JOIN exomem_tenants AS tenant ON tenant.owner_user_id = identity.id`
    );
    assert.equal(owners.rowCount, 1);
    assert.equal(owners.rows[0]!.id, owners.rows[0]!.owner_user_id);
    assert.equal((await pool!.query("SELECT count(*)::int AS n FROM users")).rows[0]!.n, 0);
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

  // A new verified invitation to an erased address creates a fresh identity;
  // the old principal and tenant remain as deleted history.
  it("admits a fresh account after deletion through the same capacity check", async () => {
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-readmit-${randomUUID()}@example.test`;

    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);

    // Simulate the day-30 export-window sweep (or a manual release) fully
    // deleting the cell, followed by controller-confirmed physical cleanup
    // at the desired generation.
    await pool!.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation + 1 WHERE cell_id = $1",
      [admitted!.cellId]
    );
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [admitted!.tenantId]
    );
    // As the lifecycle reconcile does: the deleted tenant's owner keeps only a tombstone.
    await pool!.query(
      `UPDATE exomem_users AS identity
       SET email = NULL, email_verified_at = NULL, deleted_at = now()
       FROM exomem_tenants AS tenant
       WHERE tenant.id = $1 AND identity.id = tenant.owner_user_id`,
      [admitted!.tenantId]
    );

    // A fresh invite for the same owner: same capacity (still 1 slot, and
    // the deleted cell no longer counts as used), so this must succeed, not
    // hit HOSTED_ADMISSION_CLOSED and not hit the "already has a tenant"
    // dedupe rejection either.
    const second = await createInvite("complimentary", email);
    const readmitted = await redeemCloudInviteAtomic(redemptionInput(second.tokenDigest));
    assert.ok(readmitted);
    assert.notEqual(readmitted!.tenantId, admitted!.tenantId, "a deleted NULL-email principal is not recovered by address");
    assert.notEqual(readmitted!.cellId, admitted!.cellId, "gets a genuinely new cell row");

    const tenant = await pool!.query(
      "SELECT status, desired_state, deleted_at FROM exomem_tenants WHERE id = $1",
      [readmitted!.tenantId]
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

  // Lifecycle blocks remain attached to the deleted principal, not to an erased address.
  async function deleteAsAlphaLifecycleDid(admitted: { tenantId: string; cellId: string; userId: string }) {
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation + 1 WHERE cell_id = $1", [admitted.cellId]);
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [admitted.tenantId]
    );
    // As the lifecycle reconcile does: the deleted tenant's owner keeps only a tombstone.
    await pool!.query(
      `UPDATE exomem_users AS identity
       SET email = NULL, email_verified_at = NULL, deleted_at = now()
       FROM exomem_tenants AS tenant
       WHERE tenant.id = $1 AND identity.id = tenant.owner_user_id`,
      [admitted.tenantId]
    );
    await pool!.query(
      "INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason) VALUES ($1, $2, 'lifecycle_deleted')",
      [admitted.tenantId, admitted.userId]
    );
  }

  it("admits a fresh identity after lifecycle deletion while retaining the old lifecycle block", async () => {
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-readmit-lifecycle-${randomUUID()}@example.test`;

    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);
    await deleteAsAlphaLifecycleDid(admitted!);

    const second = await createInvite("complimentary", email);
    const readmitted = await redeemCloudInviteAtomic(redemptionInput(second.tokenDigest));
    assert.ok(readmitted);
    assert.notEqual(readmitted!.tenantId, admitted!.tenantId);
    const blocks = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_oauth_account_blocks WHERE tenant_id = $1",
      [admitted!.tenantId]
    );
    assert.equal(blocks.rows[0]!.n, 1, "the old principal keeps its lifecycle block");
  });

  it("still refuses an owner an operator revoked, leaving the invite unconsumed", async () => {
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-readmit-revoked-${randomUUID()}@example.test`;

    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation + 1 WHERE cell_id = $1", [admitted!.cellId]);
    await pool!.query(
      "INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason) VALUES ($1, $2, 'operator_revoked')",
      [admitted!.tenantId, admitted!.userId]
    );

    const second = await createInvite("complimentary", email);
    await assert.rejects(redeemCloudInviteAtomic(redemptionInput(second.tokenDigest)));
    const invite = await pool!.query("SELECT consumed_at FROM exomem_invites WHERE token_digest = $1", [
      second.tokenDigest,
    ]);
    assert.equal(invite.rows[0]!.consumed_at, null);
    const blocks = await pool!.query(
      "SELECT blocked_reason FROM exomem_oauth_account_blocks WHERE tenant_id = $1",
      [admitted!.tenantId]
    );
    assert.equal(blocks.rows[0]!.blocked_reason, "operator_revoked", "an operator ban is never cleared by an invite");
  });

  it("keeps the old operator ban after deletion while admitting a newly invited independent account", async () => {
    const { revokeOperatorOAuthAccount } = await import("../operator-controls");
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-readmit-lifecycle-then-revoked-${randomUUID()}@example.test`;

    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);
    await deleteAsAlphaLifecycleDid(admitted!);
    await revokeOperatorOAuthAccount({ ownerUserId: admitted!.userId, tenantId: admitted!.tenantId });
    const recorded = await pool!.query(
      "SELECT blocked_reason FROM exomem_oauth_account_blocks WHERE tenant_id = $1",
      [admitted!.tenantId]
    );
    assert.equal(recorded.rows[0]!.blocked_reason, "operator_revoked", "the ban outranks the lifecycle block");

    const second = await createInvite("complimentary", email);
    const fresh = await redeemCloudInviteAtomic(redemptionInput(second.tokenDigest));
    assert.ok(fresh);
    assert.notEqual(fresh.userId, admitted!.userId);
    assert.notEqual(fresh.tenantId, admitted!.tenantId);
    const old = (await pool!.query("SELECT email, deleted_at FROM exomem_users WHERE id = $1", [admitted!.userId])).rows[0]!;
    assert.equal(old.email, null);
    assert.ok(old.deleted_at);
    const blocks = await pool!.query(
      "SELECT blocked_reason FROM exomem_oauth_account_blocks WHERE tenant_id = $1",
      [admitted!.tenantId]
    );
    assert.equal(blocks.rows[0]!.blocked_reason, "operator_revoked");
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
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation + 1 WHERE cell_id = $1", [
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

  // Opening checkout moves the tenant to `checkout_pending`; an abandoned
  // checkout must still expire, or it holds its slot forever.
  for (const sourceState of ["awaiting_checkout", "checkout_pending"] as const) {
    it(`expires an unpaid invite after 7 days by cancelling its transaction and deleting the row (${sourceState})`, async () => {
      await resetFleet();
      await configureCapacity(2);
      const paid = await createInvite("paddle");
      const result = await redeemCloudInviteAtomic(redemptionInput(paid.tokenDigest));
      assert.ok(result);
      await pool!.query(
        `UPDATE exomem_entitlements
         SET provider_transaction_ref = 'txn_expiretest0000000000000',
             provider_environment = 'sandbox',
             source_state = $2
         WHERE tenant_id = $1`,
        [result!.tenantId, sourceState]
      );
      await pool!.query("UPDATE exomem_cloud_cells SET created_at = now() - interval '8 days' WHERE cell_id = $1", [
        result!.cellId,
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
  }

  it("gives a re-admitted tenant a full 7-day hold from its new cell, and schedules its reminder from that cell", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-rehold-${randomUUID()}@example.test`;
    const first = await redeemCloudInviteAtomic(
      redemptionInput((await createInvite("paddle", email)).tokenDigest)
    );
    assert.ok(first);
    // The first hold lapsed long ago, and the controller has cleaned up.
    await pool!.query("UPDATE exomem_tenants SET created_at = now() - interval '30 days' WHERE id = $1", [
      first!.tenantId,
    ]);
    await pool!.query("UPDATE exomem_cloud_cells SET created_at = now() - interval '30 days' WHERE cell_id = $1", [
      first!.cellId,
    ]);
    const lapsed = await expireCloudAwaitingCheckoutTenants({ config: FAKE_PADDLE_CONFIG });
    assert.deepEqual(lapsed.map((o) => o.outcome), ["expired"]);
    await pool!.query(
      "UPDATE exomem_cloud_cells SET observed_state = 'deleted', observed_generation = generation WHERE cell_id = $1",
      [first!.cellId]
    );

    const second = await redeemCloudInviteAtomic(
      redemptionInput((await createInvite("paddle", email)).tokenDigest)
    );
    assert.ok(second);
    assert.equal(second!.tenantId, first!.tenantId, "an expired unpaid cell keeps its live canonical identity");

    assert.deepEqual(await expireCloudAwaitingCheckoutTenants({ config: FAKE_PADDLE_CONFIG }), []);
    const cell = await pool!.query("SELECT desired_state FROM exomem_cloud_cells WHERE cell_id = $1", [
      second!.cellId,
    ]);
    assert.equal(cell.rows[0]!.desired_state, "stopped");
    const reminder = await pool!.query(
      `SELECT abs(extract(epoch FROM outbox.not_before - (cell.created_at + interval '5 days'))) < 1 AS due_on_day_five,
              abs(extract(epoch FROM outbox.expires_at - (cell.created_at + interval '7 days'))) < 1 AS ends_with_hold
       FROM exomem_email_outbox AS outbox
       JOIN exomem_cloud_cells AS cell ON outbox.dedupe_key = 'hold-reminder:' || cell.cell_id
       WHERE cell.cell_id = $1`,
      [second!.cellId]
    );
    assert.deepEqual(reminder.rows, [{ due_on_day_five: true, ends_with_hold: true }]);
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
    await pool!.query("UPDATE exomem_cloud_cells SET created_at = now() - interval '8 days' WHERE cell_id = $1", [
      admission!.cellId,
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
    await pool!.query("UPDATE exomem_cloud_cells SET created_at = now() - interval '8 days' WHERE cell_id = $1", [
      result!.cellId,
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

  it("stops asking Paddle at its time budget and keeps every unsettled hold for the next tick", async () => {
    await resetFleet();
    await configureCapacity(3);
    const cells: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const paid = await createInvite("paddle");
      const result = await redeemCloudInviteAtomic(redemptionInput(paid.tokenDigest));
      assert.ok(result);
      await pool!.query(
        `UPDATE exomem_entitlements
         SET provider_transaction_ref = $2, provider_environment = 'sandbox'
         WHERE tenant_id = $1`,
        [result!.tenantId, `txn_${randomBytes(13).toString("hex")}`]
      );
      await pool!.query("UPDATE exomem_cloud_cells SET created_at = now() - interval '8 days' WHERE cell_id = $1", [
        result!.cellId,
      ]);
      cells.push(result!.cellId);
    }

    // Paddle answers nothing until the caller gives up.
    const hanging: PaddleTransport = (_path, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const started = Date.now();
    const outcomes = await expireCloudAwaitingCheckoutTenants({
      config: FAKE_PADDLE_CONFIG,
      transport: hanging,
      budgetMs: 300,
    });
    const elapsedMs = Date.now() - started;

    // Each hanging call would otherwise wait out its own 10-second deadline.
    assert.ok(elapsedMs < 3_000, `the expiry took ${elapsedMs} ms`);
    assert.deepEqual(
      outcomes.map((o) => o.outcome),
      ["deferred", "deferred", "deferred"]
    );
    const stopped = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_cloud_cells WHERE cell_id = ANY($1::text[]) AND desired_state = 'stopped'",
      [cells]
    );
    assert.equal(stopped.rows[0]!.n, 3);
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

    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation + 1 WHERE cell_id = $1", [
      admitted!.cellId,
    ]);
    await pool!.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [admitted!.tenantId]
    );
    // As the lifecycle reconcile does: the deleted tenant's owner keeps only a tombstone.
    await pool!.query(
      `UPDATE exomem_users AS identity
       SET email = NULL, email_verified_at = NULL, deleted_at = now()
       FROM exomem_tenants AS tenant
       WHERE tenant.id = $1 AND identity.id = tenant.owner_user_id`,
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
    assert.notEqual(readmitted!.tenantId, admitted!.tenantId);
    assert.notEqual(readmitted!.cellId, admitted!.cellId);
  });

  it("admits a fresh OAuth identity after lifecycle deletion without restoring the old principal", async () => {
    await resetFleet();
    await configureCapacity(1);
    const email = `cloud-oauth-readmit-lifecycle-${randomUUID()}@example.test`;
    const admit = async (fixture: Awaited<ReturnType<typeof createCloudOAuthFixture>>) =>
      admitFirstCloudOAuthInviteAtomic({
        inviteDigest: fixture.inviteDigest,
        transactionDigest: fixture.transactionDigest,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        codeDigest: randomBytes(32),
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });

    const admitted = await admit(await createCloudOAuthFixture(email));
    assert.ok(admitted);
    const owner = await pool!.query("SELECT owner_user_id FROM exomem_tenants WHERE id = $1", [admitted!.tenantId]);
    await deleteAsAlphaLifecycleDid({ ...admitted!, userId: owner.rows[0]!.owner_user_id });

    const readmitted = await admit(await createCloudOAuthFixture(email));
    assert.ok(readmitted);
    assert.notEqual(readmitted!.tenantId, admitted!.tenantId);
    const blocks = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_oauth_account_blocks WHERE tenant_id = $1",
      [admitted!.tenantId]
    );
    assert.equal(blocks.rows[0]!.n, 1);
  });

  it("refuses Cloud OAuth admission for an operator-revoked owner, leaving the invite and transaction unconsumed", async () => {
    await resetFleet();
    await configureCapacity(2);
    const email = `cloud-oauth-revoked-${randomUUID()}@example.test`;
    const first = await createInvite("complimentary", email);
    const admitted = await redeemCloudInviteAtomic(redemptionInput(first.tokenDigest));
    assert.ok(admitted);
    await pool!.query("UPDATE exomem_cloud_cells SET desired_state = 'deleted', observed_state = 'deleted', observed_generation = generation + 1 WHERE cell_id = $1", [admitted!.cellId]);
    await pool!.query(
      "INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason) VALUES ($1, $2, 'operator_revoked')",
      [admitted!.tenantId, admitted!.userId]
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
    const transaction = await pool!.query(
      "SELECT consumed_at FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1",
      [fixture.transactionDigest]
    );
    assert.equal(transaction.rows[0]!.consumed_at, null);
    const cells = await pool!.query(
      "SELECT count(*)::int AS n FROM exomem_cloud_cells WHERE tenant_id = $1 AND desired_state <> 'deleted'",
      [admitted!.tenantId]
    );
    assert.equal(cells.rows[0]!.n, 0, "a refused owner holds no capacity slot");
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

  // A friend joins through a paid invite from the consent page of the app they are
  // connecting. Before this change the invite minted a code before payment, and every
  // tool call on the resulting connection failed until checkout.
  describe("a paid invite redeemed from the consent page pays before its first grant", () => {
    const priorEnv: Record<string, string | undefined> = {};
    before(() => {
      for (const key of ["EXOMEM_CONTROL_PLANE_KEY"]) {
        priorEnv[key] = process.env[key];
      }
      process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 11).toString("base64url");
    });
    after(() => {
      for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    // Admits a paid invite under a real OAuth continuation, as the redeem route does
    // when the invitation is accepted in the browser that holds the consent page.
    async function admitPaidInviteFromConsentPage() {
      await resetFleet();
      await configureCapacity(1);
      const fixture = await createCloudOAuthFixture(undefined, false, "paddle");
      const continuation = await createOAuthContinuation({
        clientId: fixture.clientId,
        redirectUri: fixture.redirectUri,
        resource: "https://cloud.example.test/mcp/v1",
        scopes: ["exomem.read", "exomem.write"],
        state: "paid-invite-state",
        codeChallenge: "paid-invite-challenge",
        offlineAccess: false,
      });
      assert.ok(continuation, "the consent page holds a live OAuth transaction");
      const transactionDigest = tokenDigest(continuation.transaction)!;
      const admitted = await admitFirstCloudOAuthInviteAtomic({
        inviteDigest: fixture.inviteDigest,
        transactionDigest,
        sessionDigest: randomBytes(32),
        csrfDigest: randomBytes(32),
        sessionExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        codeDigest: randomBytes(32),
        codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      assert.ok(admitted);
      return { fixture, transaction: continuation.transaction, transactionDigest, admitted };
    }

    it("admits and signs in a paid invite, but mints no grant or code and leaves the transaction open", async () => {
      const { fixture, transactionDigest, admitted } = await admitPaidInviteFromConsentPage();

      assert.equal(admitted.grantId, null);
      const counts = await pool!.query(
        `SELECT
           (SELECT count(*)::int FROM exomem_oauth_grants WHERE tenant_id = $1) AS grants,
           (SELECT count(*)::int FROM exomem_oauth_authorization_codes) AS codes,
           (SELECT count(*)::int FROM exomem_sessions WHERE id = $2) AS sessions`,
        [admitted.tenantId, admitted.sessionId]
      );
      assert.deepEqual(counts.rows[0], { grants: 0, codes: 0, sessions: 1 });
      const transaction = await pool!.query(
        "SELECT consumed_at FROM exomem_oauth_authorization_transactions WHERE transaction_digest = $1",
        [transactionDigest]
      );
      assert.equal(transaction.rows[0]!.consumed_at, null, "the consent page can still connect");
      const invite = await pool!.query(
        "SELECT consumed_at FROM exomem_invites WHERE token_digest = $1",
        [fixture.inviteDigest]
      );
      assert.notEqual(invite.rows[0]!.consumed_at, null, "the invitation is spent once");
      const entitlement = await pool!.query(
        "SELECT source_state FROM exomem_entitlements WHERE tenant_id = $1",
        [admitted.tenantId]
      );
      assert.equal(entitlement.rows[0]!.source_state, "awaiting_checkout");
    });

    it("refuses consent while the first payment is outstanding, and grants it once payment settles", async () => {
      const { transactionDigest, admitted } = await admitPaidInviteFromConsentPage();
      const connect = () =>
        attachExistingOwnerAuthorizationAtomic({
          sessionId: admitted.sessionId,
          transactionDigest,
          codeDigest: randomBytes(32),
          codeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });

      // Both pre-payment states carry effective state `provisioning`, which the
      // gate used to accept.
      for (const sourceState of ["awaiting_checkout", "checkout_pending"]) {
        await pool!.query(
          "UPDATE exomem_entitlements SET source_state = $2, effective_state = 'provisioning' WHERE tenant_id = $1",
          [admitted.tenantId, sourceState]
        );
        assert.equal(await connect(), null, `${sourceState} must not connect`);
      }

      await pool!.query(
        "UPDATE exomem_entitlements SET source_state = 'active', effective_state = 'active' WHERE tenant_id = $1",
        [admitted.tenantId]
      );
      const granted = await connect();
      assert.ok(granted, "a paid owner connects through the same transaction");
      assert.equal(granted.tenantId, admitted.tenantId);
    });

    it("returns a settled checkout to the consent page only while the OAuth transaction is live", async () => {
      const { transaction, transactionDigest } = await admitPaidInviteFromConsentPage();
      const withCookie = new Request("https://substrate.example.test/api/exomem/billing/checkout", {
        headers: { cookie: `exomem_oauth_tx=${transaction}` },
      });

      assert.equal(await liveOAuthConsentPath(withCookie), oauthConsentPath(transaction));

      await pool!.query(
        `UPDATE exomem_oauth_authorization_transactions
         SET created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second'
         WHERE transaction_digest = $1`,
        [transactionDigest]
      );
      assert.equal(await liveOAuthConsentPath(withCookie), null, "an expired request goes Home");
      assert.equal(
        await liveOAuthConsentPath(
          new Request("https://substrate.example.test/api/exomem/billing/checkout")
        ),
        null,
        "no OAuth cookie goes Home"
      );
    });
  });
});
