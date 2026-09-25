import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { redeemCloudInviteAtomic } from "../cloud-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import { dispatchVerifiedExomemPaddleEvent } from "../paddle-webhook";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Part B (independent security review, pre-existing HIGH found alongside
// task 3.10): a Cloud tenant's paid activation webhook drove
// `requires_provision_release` true, and the guard that releases the v1
// capacity reservation then divided by zero because a Cloud tenant has no
// `exomem_capacity_allocations` row -- Cloud provisions through cellctl, not
// through v1 capacity. The entitlement never became active, no ledger row
// was written, Paddle retried forever, and the Cloud hook never ran.
//
// These drive `createSqlExomemPaddleEventStore` through the real webhook
// dispatcher (`dispatchVerifiedExomemPaddleEvent`), with real Paddle event
// payload shapes, not a direct UPDATE -- the bug this reproduces is
// specifically about that atomic apply statement, and the existing Cloud
// suites all simulate activation with a direct UPDATE, which is why nothing
// caught it.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;
const priorEnv: Record<string, string | undefined> = {};

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

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
    ...overrides,
  };
}

const PADDLE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function paddleId(prefix: "sub" | "ctm" | "txn" | "evt"): string {
  const bytes = randomBytes(26);
  let id = "";
  for (const byte of bytes) id += PADDLE_ID_ALPHABET[byte % PADDLE_ID_ALPHABET.length];
  return `${prefix}_${id}`;
}

type CloudPaidTenant = { tenantId: string; userId: string; cellId: string };

/** A paid Cloud admission (D1): `awaiting_checkout`, `stopped` cell, holding its capacity slot. */
async function admitPaidCloudTenant(): Promise<CloudPaidTenant> {
  await pool!.query("INSERT INTO exomem_cloud_capacity (node, cell_slots) VALUES ($1, 20)", [
    `node-${randomUUID()}`,
  ]);
  const email = `cloud-activation-${randomUUID()}@example.test`;
  const inviteDigest = randomBytes(32);
  await pool!.query(
    `INSERT INTO exomem_invites (
       token_digest, email_normalized, entitlement_source, entitlement_capabilities,
       entitlement_limits, created_by_principal_digest, expires_at
     ) VALUES ($1, $2, 'paddle', '["capture","recall"]'::jsonb, '{}'::jsonb, $3, now() + interval '1 day')`,
    [inviteDigest, email, randomBytes(32)]
  );
  const redeemed = await redeemCloudInviteAtomic({
    tokenDigest: inviteDigest,
    sessionDigest: randomBytes(32),
    csrfDigest: randomBytes(32),
    sessionExpiresAt: new Date(Date.now() + 3600e3),
  });
  assert.ok(redeemed, "sanity: the invite redeems");
  return { tenantId: redeemed!.tenantId, userId: redeemed!.userId, cellId: redeemed!.cellId };
}

/** What a checkout leaves bound on the entitlement before the activation webhook arrives. */
async function bindCheckout(tenant: CloudPaidTenant, transactionId: string): Promise<void> {
  await pool!.query(
    `UPDATE exomem_entitlements
     SET provider_transaction_ref = $2, provider_environment = 'sandbox'
     WHERE tenant_id = $1`,
    [tenant.tenantId, transactionId]
  );
}

function rawEvent(input: {
  tenant: CloudPaidTenant;
  eventId: string;
  eventType: string;
  status: string;
  subscriptionId: string;
  transactionId: string;
}): Record<string, unknown> {
  const isTransactionEvent = input.eventType.startsWith("transaction.");
  return {
    event_id: input.eventId,
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    environment: "sandbox",
    data: {
      id: isTransactionEvent ? input.transactionId : input.subscriptionId,
      transaction_id: input.transactionId,
      customer_id: paddleId("ctm"),
      status: input.status,
      custom_data: {
        product_key: "exomem-hosted",
        user_id: input.tenant.userId,
        tenant_id: input.tenant.tenantId,
      },
    },
  };
}

describe(
  "Exomem Cloud paid activation through the real Paddle event store",
  { skip: !databaseUrl },
  () => {
    before(async () => {
      priorEnv.EXOMEM_CLOUD_ENABLED = process.env.EXOMEM_CLOUD_ENABLED;
      process.env.EXOMEM_CLOUD_ENABLED = "1";
      schema = `cloud_paddle_activation_it_${randomUUID().replaceAll("-", "")}`;
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
      if (priorEnv.EXOMEM_CLOUD_ENABLED === undefined) delete process.env.EXOMEM_CLOUD_ENABLED;
      else process.env.EXOMEM_CLOUD_ENABLED = priorEnv.EXOMEM_CLOUD_ENABLED;
    });

    it("Part B: a Cloud tenant's subscription.activated applies, projects, starts the cell, and dedupes on replay", async () => {
      const tenant = await admitPaidCloudTenant();
      const transactionId = paddleId("txn");
      const subscriptionId = paddleId("sub");
      await bindCheckout(tenant, transactionId);
      const store = createSqlExomemPaddleEventStore(taggedSql(pool!));
      const eventId = paddleId("evt");
      const application = rawEvent({
        tenant,
        eventId,
        eventType: "subscription.activated",
        status: "active",
        subscriptionId,
        transactionId,
      });

      const result = await dispatchVerifiedExomemPaddleEvent(application, { env: env(), store });
      assert.deepEqual(result, { kind: "handled", outcome: "applied" });

      const entitlement = await pool!.query<{
        source_state: string;
        provider_subscription_ref: string | null;
      }>(
        `SELECT source_state, provider_subscription_ref
           FROM exomem_entitlements WHERE tenant_id = $1`,
        [tenant.tenantId]
      );
      // The store's own atomic write projects `source_state` from Paddle and
      // binds the subscription ref; `effective_state` there is a snapshot at
      // that same instant (the tenant row is still `provisioning`, D1's
      // admission default). The Cloud hook below is what carries the tenant
      // to `active` -- Cloud gates on the cell's desired_state, not on this
      // entitlement column (cloud-lifecycle.ts's tenant-mirror comment).
      assert.equal(entitlement.rows[0]!.source_state, "active");
      assert.equal(entitlement.rows[0]!.provider_subscription_ref, subscriptionId);

      const ledger = await pool!.query<{ disposition: string }>(
        "SELECT disposition FROM exomem_paddle_events WHERE paddle_event_id = $1",
        [eventId]
      );
      assert.equal(ledger.rows[0]!.disposition, "applied");

      const cell = await pool!.query<{ desired_state: string }>(
        "SELECT desired_state FROM exomem_cloud_cells WHERE tenant_id = $1",
        [tenant.tenantId]
      );
      assert.equal(cell.rows[0]!.desired_state, "running", "the Cloud hook ran and started the cell");

      const tenantRow = await pool!.query<{ status: string }>(
        "SELECT status FROM exomem_tenants WHERE id = $1",
        [tenant.tenantId]
      );
      assert.equal(tenantRow.rows[0]!.status, "active", "the tenant mirror followed the cell to active");

      const replay = await dispatchVerifiedExomemPaddleEvent(application, { env: env(), store });
      assert.deepEqual(replay, { kind: "handled", outcome: "duplicate" });
    });

    it("Part B: transaction.completed, subscription.canceled and subscription.past_due never throw for a Cloud tenant", async () => {
      const store = createSqlExomemPaddleEventStore(taggedSql(pool!));

      async function activatedTenant(): Promise<{
        tenant: CloudPaidTenant;
        subscriptionId: string;
        transactionId: string;
      }> {
        const tenant = await admitPaidCloudTenant();
        const transactionId = paddleId("txn");
        const subscriptionId = paddleId("sub");
        await bindCheckout(tenant, transactionId);
        const activated = await dispatchVerifiedExomemPaddleEvent(
          rawEvent({
            tenant,
            eventId: paddleId("evt"),
            eventType: "subscription.activated",
            status: "active",
            subscriptionId,
            transactionId,
          }),
          { env: env(), store }
        );
        assert.deepEqual(activated, { kind: "handled", outcome: "applied" }, "sanity: activation applies");
        return { tenant, subscriptionId, transactionId };
      }

      {
        const { tenant, subscriptionId, transactionId } = await activatedTenant();
        const result = await dispatchVerifiedExomemPaddleEvent(
          rawEvent({
            tenant,
            eventId: paddleId("evt"),
            eventType: "transaction.completed",
            status: "completed",
            subscriptionId,
            transactionId,
          }),
          { env: env(), store }
        );
        assert.equal(result.kind, "handled", "transaction.completed does not throw or get rejected");
      }

      {
        const { tenant, subscriptionId, transactionId } = await activatedTenant();
        const result = await dispatchVerifiedExomemPaddleEvent(
          rawEvent({
            tenant,
            eventId: paddleId("evt"),
            eventType: "subscription.canceled",
            status: "canceled",
            subscriptionId,
            transactionId,
          }),
          { env: env(), store }
        );
        assert.deepEqual(result, { kind: "handled", outcome: "applied" });
        const cell = await pool!.query<{ desired_state: string }>(
          "SELECT desired_state FROM exomem_cloud_cells WHERE tenant_id = $1",
          [tenant.tenantId]
        );
        assert.equal(
          cell.rows[0]!.desired_state,
          "read_only",
          "D4: a fresh cancellation is read_only for its export window"
        );
      }

      {
        const { tenant, subscriptionId, transactionId } = await activatedTenant();
        const result = await dispatchVerifiedExomemPaddleEvent(
          rawEvent({
            tenant,
            eventId: paddleId("evt"),
            eventType: "subscription.past_due",
            status: "past_due",
            subscriptionId,
            transactionId,
          }),
          { env: env(), store }
        );
        assert.equal(result.kind, "handled", "subscription.past_due does not throw or get rejected");
      }
    });
  }
);
