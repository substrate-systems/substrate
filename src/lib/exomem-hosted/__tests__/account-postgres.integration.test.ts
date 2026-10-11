import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { loadExomemAccountView } from "../account-view";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { loadExomemPaddleConfig } from "../paddle-config";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import { reconcileExomemPaddleSubscription } from "../paddle-reconciliation";
import { dispatchVerifiedExomemPaddleEvent } from "../paddle-webhook";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const MIGRATIONS = resolve(process.cwd(), "migrations");
const ACCOUNT_FACTS_MIGRATION = "0064_exomem_account_facts.sql";
const SUPPORT_REFERENCE = /^[0-9A-HJKMNP-TV-Z]{4,8}$/;
const FRIEND_DISCOUNT = "dsc_friend_price_example";
const ACCOUNT_ENVIRONMENT = {
  EXOMEM_PADDLE_DUNNING_DAYS: "14",
  EXOMEM_PADDLE_FRIEND_DISCOUNT_ID: FRIEND_DISCOUNT,
};
const WEBHOOK_ENVIRONMENT = {
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
};

let pool: Pool;
let schema: string;
let migrationsBefore: string;
const legacy: Record<"complimentary" | "pastDueWithReceipt" | "pastDueWithoutReceipt", string> = {
  complimentary: "",
  pastDueWithReceipt: "",
  pastDueWithoutReceipt: "",
};

function taggedSql(client: Pool): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

async function insertTenant(): Promise<{ userId: string; tenantId: string }> {
  const user = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [
    `account-${randomUUID()}@example.test`,
  ]);
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
    [user.rows[0].id]
  );
  return { userId: String(user.rows[0].id), tenantId: String(tenant.rows[0].id) };
}

async function insertPaddleTenant(sourceState: string) {
  const tenant = await insertTenant();
  const subscriptionId = `sub_${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `INSERT INTO exomem_entitlements (
       tenant_id, source, source_state, effective_state, provider_environment,
       provider_customer_ref, provider_subscription_ref, source_occurred_at, source_revision
     ) VALUES ($1, 'paddle', $2, 'active', 'sandbox', $3, $4, '2026-09-01T00:00:00Z', 'evt_initial')`,
    [tenant.tenantId, sourceState, `ctm_${randomUUID().replaceAll("-", "")}`, subscriptionId]
  );
  return { ...tenant, subscriptionId };
}

async function entitlementFacts(tenantId: string) {
  const { rows } = await pool.query(
    `SELECT provider_price_id, provider_price_name, provider_next_billed_at, provider_discount_id,
            provider_scheduled_change_at, grace_started_at
       FROM exomem_entitlements WHERE tenant_id = $1`,
    [tenantId]
  );
  return rows[0];
}

function subscriptionEvent(
  tenant: { userId: string; tenantId: string; subscriptionId: string },
  input: {
    eventId?: string;
    eventType?: string;
    occurredAt: string;
    status: string;
    nextBilledAt?: string | null;
    discountId?: string | null;
    scheduledChangeAt?: string;
  }
): Record<string, unknown> {
  return {
    event_id: input.eventId ?? `evt_${randomUUID().replaceAll("-", "")}`,
    event_type: input.eventType ?? "subscription.updated",
    occurred_at: input.occurredAt,
    environment: "sandbox",
    data: {
      id: tenant.subscriptionId,
      status: input.status,
      next_billed_at: input.nextBilledAt ?? null,
      discount: input.discountId
        ? { id: input.discountId, starts_at: input.occurredAt, ends_at: null }
        : null,
      scheduled_change: input.scheduledChangeAt
        ? { action: "cancel", effective_at: input.scheduledChangeAt, resume_at: null }
        : null,
      items: [
        { price: { id: "pri_monthly_example", product_id: "pro_exomem_example", name: "Monthly" } },
      ],
      custom_data: {
        product_key: "exomem-hosted",
        user_id: tenant.userId,
        tenant_id: tenant.tenantId,
      },
    },
  };
}

async function dispatch(event: Record<string, unknown>) {
  return dispatchVerifiedExomemPaddleEvent(event, {
    env: WEBHOOK_ENVIRONMENT,
    store: createSqlExomemPaddleEventStore(taggedSql(pool)),
    // The Cloud cell hook is not under test; these tenants have no cell.
    cloudHook: async () => undefined,
  });
}

function account(tenant: { userId: string; tenantId: string }) {
  return loadExomemAccountView(
    { ...tenant, reviewerCredentialId: null },
    { environment: ACCOUNT_ENVIRONMENT }
  );
}

describe("Exomem account facts on PostgreSQL", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `account_facts_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);

    // Upgrade a populated database: every migration before 0064 first, then rows, then 0064.
    migrationsBefore = mkdtempSync(join(tmpdir(), "exomem-account-migrations-"));
    for (const name of readdirSync(MIGRATIONS).filter((file) => file < ACCOUNT_FACTS_MIGRATION)) {
      copyFileSync(join(MIGRATIONS, name), join(migrationsBefore, name));
    }
    await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir: migrationsBefore });
    pool = new Pool({ connectionString: scoped.toString() });

    legacy.complimentary = (await insertTenant()).tenantId;
    await pool.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'complimentary_active', 'active')",
      [legacy.complimentary]
    );
    legacy.pastDueWithReceipt = (await insertPaddleTenant("past_due")).tenantId;
    for (const [eventId, occurredAt] of [
      ["evt_earlier_period", "2026-08-01T00:00:00Z"],
      ["evt_current_period", "2026-09-20T08:00:00Z"],
    ]) {
      await pool.query(
        `INSERT INTO exomem_paddle_events (paddle_event_id, environment, event_type, tenant_id, occurred_at, disposition)
         VALUES ($1, 'sandbox', 'subscription.past_due', $2, $3, 'applied')`,
        [eventId, legacy.pastDueWithReceipt, occurredAt]
      );
    }
    legacy.pastDueWithoutReceipt = (await insertPaddleTenant("past_due")).tenantId;

    await applyMigrations({ databaseUrl: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
  });

  after(async () => {
    __setExomemSqlForTests(null);
    if (pool) await pool.end();
    if (migrationsBefore) rmSync(migrationsBefore, { recursive: true, force: true });
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("gives every tenant that existed before the upgrade its own support reference", async () => {
    const { rows } = await pool.query(
      "SELECT support_reference FROM exomem_tenants WHERE id = ANY($1::uuid[])",
      [Object.values(legacy)]
    );
    const references = rows.map((row) => String(row.support_reference));
    assert.equal(references.length, 3);
    for (const reference of references) assert.match(reference, SUPPORT_REFERENCE);
    assert.equal(new Set(references).size, references.length);
  });

  it("starts an existing past_due period at its latest past_due receipt, and leaves it unknown without one", async () => {
    assert.equal(
      (await entitlementFacts(legacy.pastDueWithReceipt)).grace_started_at.toISOString(),
      "2026-09-20T08:00:00.000Z"
    );
    assert.equal((await entitlementFacts(legacy.pastDueWithoutReceipt)).grace_started_at, null);
  });

  it("draws a distinct support reference for each new tenant that stays the same across reads", async () => {
    const first = await insertPaddleTenant("active");
    const second = await insertPaddleTenant("active");
    const firstReads = [
      (await account(first)).supportReference,
      (await account(first)).supportReference,
    ];
    const secondReference = (await account(second)).supportReference;

    assert.equal(firstReads[0], firstReads[1]);
    assert.match(firstReads[0], /^EX-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.notEqual(firstReads[0], secondReference);
  });

  it("stores the facts a subscription.updated event reports, returns them on the account, and ignores a replay", async () => {
    const tenant = await insertPaddleTenant("active");
    const event = subscriptionEvent(tenant, {
      occurredAt: "2026-10-01T09:00:00Z",
      status: "active",
      nextBilledAt: "2026-11-01T09:00:00Z",
      discountId: FRIEND_DISCOUNT,
      scheduledChangeAt: "2026-11-01T09:00:00Z",
    });

    assert.deepEqual(await dispatch(event), { kind: "handled", outcome: "applied" });
    const stored = await entitlementFacts(tenant.tenantId);
    assert.equal(stored.provider_price_id, "pri_monthly_example");
    assert.equal(stored.provider_price_name, "Monthly");
    assert.equal(stored.provider_next_billed_at.toISOString(), "2026-11-01T09:00:00.000Z");
    assert.equal(stored.provider_discount_id, FRIEND_DISCOUNT);
    assert.equal(stored.provider_scheduled_change_at.toISOString(), "2026-11-01T09:00:00.000Z");

    const view = await account(tenant);
    assert.deepEqual(view.plan.name, { value: "Monthly", reason: null });
    assert.equal(view.plan.friendPrice.applied, true);
    assert.deepEqual(view.nextPaymentAt, { value: "2026-11-01T09:00:00.000Z", reason: null });
    assert.deepEqual(view.readOnlyUntil, { value: null, reason: "not_past_due" });

    // Paddle redelivers by event id; a redelivery never rewrites the stored facts.
    const redelivered = structuredClone(event);
    (redelivered.data as Record<string, unknown>).next_billed_at = "2027-01-01T00:00:00Z";
    assert.deepEqual(await dispatch(redelivered), { kind: "handled", outcome: "duplicate" });
    assert.deepEqual(await entitlementFacts(tenant.tenantId), stored);
  });

  it("starts the read-only period at the first past_due event, keeps it through later ones, and clears it on recovery", async () => {
    const tenant = await insertPaddleTenant("active");

    await dispatch(
      subscriptionEvent(tenant, {
        eventType: "subscription.past_due",
        occurredAt: "2026-10-02T10:00:00Z",
        status: "past_due",
        nextBilledAt: "2026-10-02T10:00:00Z",
      })
    );
    await dispatch(
      subscriptionEvent(tenant, { occurredAt: "2026-10-05T10:00:00Z", status: "past_due" })
    );
    assert.equal(
      (await entitlementFacts(tenant.tenantId)).grace_started_at.toISOString(),
      "2026-10-02T10:00:00.000Z"
    );
    assert.deepEqual((await account(tenant)).readOnlyUntil, {
      value: "2026-10-16T10:00:00.000Z",
      reason: null,
    });

    await dispatch(
      subscriptionEvent(tenant, {
        eventType: "subscription.activated",
        occurredAt: "2026-10-06T10:00:00Z",
        status: "active",
        nextBilledAt: "2026-11-06T10:00:00Z",
      })
    );
    assert.equal((await entitlementFacts(tenant.tenantId)).grace_started_at, null);
    assert.deepEqual((await account(tenant)).readOnlyUntil, {
      value: null,
      reason: "not_past_due",
    });
  });

  it("stores the same facts from reconciliation as from the webhook", async () => {
    const tenant = await insertPaddleTenant("active");
    const event = subscriptionEvent(tenant, {
      occurredAt: "2026-10-03T12:00:00Z",
      status: "active",
      nextBilledAt: "2026-11-03T12:00:00Z",
      discountId: FRIEND_DISCOUNT,
    });

    const result = await reconcileExomemPaddleSubscription(
      {
        userId: tenant.userId,
        tenantId: tenant.tenantId,
        subscriptionId: tenant.subscriptionId,
        environment: "sandbox",
      },
      {
        config: loadExomemPaddleConfig({
          PADDLE_ENVIRONMENT: "sandbox",
          PADDLE_API_KEY: "pdl_sdbx_apikey_example",
          EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem_example",
        }),
        store: createSqlExomemPaddleEventStore(taggedSql(pool)),
        transport: async () =>
          Response.json({
            data: { ...(event.data as object), updated_at: "2026-10-03T12:00:00Z" },
          }),
      }
    );

    assert.deepEqual(result, { outcome: "applied" });
    const stored = await entitlementFacts(tenant.tenantId);
    assert.equal(stored.provider_price_id, "pri_monthly_example");
    assert.equal(stored.provider_price_name, "Monthly");
    assert.equal(stored.provider_next_billed_at.toISOString(), "2026-11-03T12:00:00.000Z");
    assert.equal(stored.provider_discount_id, FRIEND_DISCOUNT);
  });
});
