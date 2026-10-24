import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { loadExomemAccountView } from "../account-view";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  saveExomemTheme,
  findExomemSessionByDigest,
  promoteExomemCheckoutSubscription,
  type ExomemSql,
} from "../db";
import { requestExomemEmailChange, completeExomemEmailChange } from "../email-change";
import { decryptSecret } from "../security";
import {
  runBoundedPaddleReceiptContacts,
  loadPaddleReceiptContact,
} from "../paddle-receipt-contact";
import { loadExomemPaddleConfig } from "../paddle-config";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import { reconcileExomemPaddleSubscription } from "../paddle-reconciliation";
import { dispatchVerifiedExomemPaddleEvent } from "../paddle-webhook";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The lifecycle emails this suite's facts enqueue carry an encrypted payload.
process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

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
type PaddleTenant = { userId: string; tenantId: string; subscriptionId: string };
let legacyComplimentary: string;
let legacyPastDueWithReceipts: PaddleTenant;
let legacyPastDueWithoutReceipt: PaddleTenant;

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

async function interactiveTransaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function emailChange(owner: { tenantId: string; userId: string }, proposed: string) {
  await requestExomemEmailChange({ ...owner, reviewerCredentialId: null }, proposed);
  const pending = (
    await pool.query("SELECT id FROM exomem_email_changes WHERE tenant_id = $1", [owner.tenantId])
  ).rows[0]!;
  const queued = await pool.query(
    "SELECT kind, recipient, tenant_id, payload_ciphertext FROM exomem_email_outbox WHERE dedupe_key IN ('email_change_confirmation:' || $1::text, 'email_change_cancellation:' || $1::text)",
    [pending.id]
  );
  assert.equal(queued.rows.length, 2);
  const confirmation = queued.rows.find((row) => row.kind === "email_change_confirmation")!;
  const cancellation = queued.rows.find((row) => row.kind === "email_change_cancellation")!;
  assert.equal(confirmation.recipient, proposed);
  assert.equal(confirmation.tenant_id, owner.tenantId);
  assert.equal(cancellation.tenant_id, owner.tenantId);
  return {
    confirm: JSON.parse(decryptSecret(confirmation.payload_ciphertext).reveal()).token as string,
    cancel: JSON.parse(decryptSecret(cancellation.payload_ciphertext).reveal()).token as string,
  };
}

// Tenants made before migration 0074 have only a shared users row; it makes the Exomem identity.
async function insertTenant(
  identityTable: "exomem_users" | "users" = "exomem_users"
): Promise<{ userId: string; tenantId: string }> {
  const user = await pool.query(`INSERT INTO ${identityTable} (email) VALUES ($1) RETURNING id`, [
    `account-${randomUUID()}@example.test`,
  ]);
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
    [user.rows[0].id]
  );
  return { userId: String(user.rows[0].id), tenantId: String(tenant.rows[0].id) };
}

async function insertPaddleTenant(
  sourceState: string,
  identityTable: "exomem_users" | "users" = "exomem_users"
) {
  const tenant = await insertTenant(identityTable);
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

async function receiptOwner(bound = true) {
  // These provider cases isolate the small projection while retaining the suite's account fixtures.
  await pool.query("DELETE FROM exomem_paddle_receipt_contacts");
  const owner = await insertPaddleTenant("cancelled");
  const customerId = `ctm_${randomBytes(13).toString("hex")}`;
  await pool.query(
    "UPDATE exomem_entitlements SET provider_customer_ref = $2 WHERE tenant_id = $1",
    [owner.tenantId, bound ? customerId : null]
  );
  const desired = `receipt-${randomUUID()}@example.test`;
  const change = await emailChange(owner, desired);
  await completeExomemEmailChange("confirm", change.confirm);
  return { ...owner, customerId, desired };
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
  tenant: PaddleTenant,
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

// Reconciliation reads the same subscription entity a webhook carries, with
// the event time as Paddle's updated_at.
async function reconcile(tenant: PaddleTenant, event: Record<string, unknown>) {
  const data = { ...(event.data as object), updated_at: event.occurred_at };
  return reconcileExomemPaddleSubscription(
    { ...tenant, environment: "sandbox" },
    {
      config: loadExomemPaddleConfig({
        PADDLE_ENVIRONMENT: "sandbox",
        PADDLE_API_KEY: "pdl_sdbx_apikey_example",
        EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem_example",
      }),
      store: createSqlExomemPaddleEventStore(taggedSql(pool)),
      transport: async () => Response.json({ data }),
    }
  );
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

    legacyComplimentary = (await insertTenant("users")).tenantId;
    await pool.query(
      "INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state) VALUES ($1, 'complimentary', 'complimentary_active', 'active')",
      [legacyComplimentary]
    );
    // An earlier past_due period that ended, then the current one. Its
    // subscription.past_due receipt is stale: a later subscription.updated
    // reached the store first.
    legacyPastDueWithReceipts = await insertPaddleTenant("past_due", "users");
    for (const [eventType, occurredAt, disposition] of [
      ["subscription.past_due", "2026-08-01T00:00:00Z", "applied"],
      ["subscription.updated", "2026-08-03T00:00:00Z", "applied"],
      ["subscription.updated", "2026-09-20T08:00:01Z", "applied"],
      ["subscription.past_due", "2026-09-20T08:00:00Z", "stale"],
    ]) {
      await pool.query(
        `INSERT INTO exomem_paddle_events (paddle_event_id, environment, event_type, tenant_id, occurred_at, disposition)
         VALUES ($1, 'sandbox', $2, $3, $4, $5)`,
        [
          `evt_${randomUUID().replaceAll("-", "")}`,
          eventType,
          legacyPastDueWithReceipts.tenantId,
          occurredAt,
          disposition,
        ]
      );
    }
    legacyPastDueWithoutReceipt = await insertPaddleTenant("past_due", "users");

    await applyMigrations({ databaseUrl: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    if (pool) await pool.end();
    if (migrationsBefore) rmSync(migrationsBefore, { recursive: true, force: true });
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("preserves an initialized explicit choice when a stale device observes Auto", async () => {
    const owner = await insertTenant();
    assert.deepEqual(
      await saveExomemTheme({ ...owner, themeChoice: "dark", emailScheme: "dark" }),
      { themeChoice: "dark", emailScheme: "dark" }
    );
    assert.deepEqual(
      await saveExomemTheme({
        ...owner,
        themeChoice: "light",
        emailScheme: "light",
        initialize: true,
      }),
      { themeChoice: "dark", emailScheme: "dark" }
    );
    assert.deepEqual(
      await saveExomemTheme({
        ...owner,
        themeChoice: "auto",
        emailScheme: "light",
        effectiveOnly: true,
      }),
      { themeChoice: "dark", emailScheme: "dark" }
    );
    assert.deepEqual(
      (
        await pool.query("SELECT theme_choice, email_scheme FROM exomem_tenants WHERE id = $1", [
          owner.tenantId,
        ])
      ).rows,
      [{ theme_choice: "dark", email_scheme: "dark" }]
    );
    assert.equal(
      await saveExomemTheme({
        ...owner,
        userId: randomUUID(),
        themeChoice: "light",
        emailScheme: "light",
      }),
      null
    );
  });

  it("gives every tenant that existed before the upgrade its own support reference", async () => {
    const { rows } = await pool.query(
      "SELECT support_reference FROM exomem_tenants WHERE id = ANY($1::uuid[])",
      [
        [
          legacyComplimentary,
          legacyPastDueWithReceipts.tenantId,
          legacyPastDueWithoutReceipt.tenantId,
        ],
      ]
    );
    const references = rows.map((row) => String(row.support_reference));
    assert.equal(references.length, 3);
    for (const reference of references) assert.match(reference, SUPPORT_REFERENCE);
    assert.equal(new Set(references).size, references.length);
  });

  it("starts an existing past_due period at its latest past_due receipt, stale included, and leaves it unknown without one", async () => {
    assert.equal(
      (await entitlementFacts(legacyPastDueWithReceipts.tenantId)).grace_started_at.toISOString(),
      "2026-09-20T08:00:00.000Z"
    );
    assert.equal(
      (await entitlementFacts(legacyPastDueWithoutReceipt.tenantId)).grace_started_at,
      null
    );
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

  it("refreshes in one reconciliation pass the facts of a subscription reconciled before they were stored", async () => {
    const tenant = await insertPaddleTenant("active");
    // What an earlier reconciliation pass left: its receipt and its revision.
    const earlierPass = `reconcile:${tenant.tenantId}:2026-10-03T12:00:00.000Z`;
    await pool.query(
      "UPDATE exomem_entitlements SET source_revision = $2, source_occurred_at = '2026-10-03T12:00:00Z' WHERE tenant_id = $1",
      [tenant.tenantId, earlierPass]
    );
    await pool.query(
      `INSERT INTO exomem_paddle_events (paddle_event_id, environment, event_type, tenant_id, occurred_at, disposition)
       VALUES ($1, 'sandbox', 'subscription.reconciled', $2, '2026-10-03T12:00:00Z', 'applied')`,
      [earlierPass, tenant.tenantId]
    );

    const result = await reconcile(
      tenant,
      subscriptionEvent(tenant, {
        occurredAt: "2026-10-03T12:00:00Z",
        status: "active",
        nextBilledAt: "2026-11-03T12:00:00Z",
        discountId: FRIEND_DISCOUNT,
      })
    );

    assert.deepEqual(result, { outcome: "applied" });
    const stored = await entitlementFacts(tenant.tenantId);
    assert.equal(stored.provider_price_id, "pri_monthly_example");
    assert.equal(stored.provider_price_name, "Monthly");
    assert.equal(stored.provider_next_billed_at.toISOString(), "2026-11-03T12:00:00.000Z");
    assert.equal(stored.provider_discount_id, FRIEND_DISCOUNT);
  });

  it("keeps an unknown past_due start unknown when reconciliation reports past_due again", async () => {
    const result = await reconcile(
      legacyPastDueWithoutReceipt,
      subscriptionEvent(legacyPastDueWithoutReceipt, {
        occurredAt: "2026-10-04T12:00:00Z",
        status: "past_due",
      })
    );

    assert.deepEqual(result, { outcome: "applied" });
    assert.equal(
      (await entitlementFacts(legacyPastDueWithoutReceipt.tenantId)).grace_started_at,
      null
    );
    assert.deepEqual((await account(legacyPastDueWithoutReceipt)).readOnlyUntil, {
      value: null,
      reason: "grace_start_unknown",
    });
  });
  it("refuses reviewer and deleting accounts before queuing an email change", async () => {
    const owner = await insertTenant();
    const proposed = `refused-${randomUUID()}@example.test`;
    await assert.rejects(
      requestExomemEmailChange({ ...owner, reviewerCredentialId: randomUUID() }, proposed),
      { code: "EXOMEM_ENTITLEMENT_DENIED" }
    );
    await pool.query(
      "UPDATE exomem_tenants SET status = 'deletion_pending', desired_state = 'deleted' WHERE id = $1",
      [owner.tenantId]
    );
    await assert.rejects(
      requestExomemEmailChange({ ...owner, reviewerCredentialId: null }, proposed),
      { code: "EXOMEM_SESSION_INVALID" }
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT
      (SELECT count(*)::int FROM exomem_email_changes WHERE tenant_id = $1) AS changes,
      (SELECT count(*)::int FROM exomem_email_outbox WHERE tenant_id = $1) AS emails`,
          [owner.tenantId]
        )
      ).rows[0],
      { changes: 0, emails: 0 }
    );
  });

  it("confirms a new canonical address while keeping the session and other product's identity", async () => {
    const owner = await insertTenant();
    // The other product keeps its own identity row under the same id and address.
    await pool.query("INSERT INTO users (id, email) SELECT id, email FROM exomem_users WHERE id = $1", [
      owner.userId,
    ]);
    const before = (await pool.query("SELECT * FROM users WHERE id = $1", [owner.userId])).rows;
    const sessionDigest = randomBytes(32);
    await pool.query(
      "INSERT INTO exomem_sessions (user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')",
      [owner.userId, owner.tenantId, sessionDigest, randomBytes(32)]
    );
    const proposed = `confirmed-${randomUUID()}@example.test`;
    const change = await emailChange(owner, proposed);
    await assert.rejects(completeExomemEmailChange("cancel", change.confirm), {
      code: "ACCESS_TOKEN_INVALID",
    });
    assert.deepEqual(await completeExomemEmailChange("confirm", change.confirm), {
      state: "confirmed",
    });
    assert.equal(
      (await pool.query("SELECT email FROM exomem_users WHERE id = $1", [owner.userId])).rows[0]!
        .email,
      proposed
    );
    assert.deepEqual(
      (await pool.query("SELECT * FROM users WHERE id = $1", [owner.userId])).rows,
      before
    );
    assert.equal((await findExomemSessionByDigest(sessionDigest))?.tenantId, owner.tenantId);
    assert.equal(
      (
        await pool.query("SELECT state FROM exomem_paddle_receipt_contacts WHERE tenant_id = $1", [
          owner.tenantId,
        ])
      ).rows[0]!.state,
      "pending"
    );
    await assert.rejects(completeExomemEmailChange("confirm", change.confirm), {
      code: "ACCESS_TOKEN_INVALID",
    });
    await assert.rejects(completeExomemEmailChange("cancel", change.cancel), {
      code: "ACCESS_TOKEN_INVALID",
    });
  });

  it("supersedes both earlier capabilities and cancellation queues no receipt intent", async () => {
    const owner = await insertTenant();
    const old = await emailChange(owner, `superseded-${randomUUID()}@example.test`);
    const current = await emailChange(owner, `current-${randomUUID()}@example.test`);
    await assert.rejects(completeExomemEmailChange("confirm", old.confirm), {
      code: "ACCESS_TOKEN_INVALID",
    });
    await assert.rejects(completeExomemEmailChange("cancel", old.cancel), {
      code: "ACCESS_TOKEN_INVALID",
    });
    assert.deepEqual(await completeExomemEmailChange("cancel", current.cancel), {
      state: "cancelled",
    });
    await assert.rejects(completeExomemEmailChange("confirm", current.confirm), {
      code: "ACCESS_TOKEN_INVALID",
    });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM exomem_paddle_receipt_contacts WHERE tenant_id = $1",
          [owner.tenantId]
        )
      ).rows[0]!.n,
      0
    );
  });

  for (const condition of ["expired", "original_changed"] as const) {
    it(`refuses a ${condition} request without changing the current identity`, async () => {
      const owner = await insertTenant();
      const change = await emailChange(owner, `invalid-${randomUUID()}@example.test`);
      if (condition === "expired")
        await pool.query(
          "UPDATE exomem_email_changes SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE tenant_id = $1",
          [owner.tenantId]
        );
      else
        await pool.query("UPDATE exomem_users SET email = $2 WHERE id = $1", [
          owner.userId,
          `moved-${randomUUID()}@example.test`,
        ]);
      const before = (
        await pool.query("SELECT email FROM exomem_users WHERE id = $1", [owner.userId])
      ).rows;
      await assert.rejects(completeExomemEmailChange("confirm", change.confirm), {
        code: "ACCESS_TOKEN_INVALID",
      });
      assert.deepEqual(
        (await pool.query("SELECT email FROM exomem_users WHERE id = $1", [owner.userId])).rows,
        before
      );
    });
  }

  it("does not reserve a proposed address or merge the account that takes it before confirmation", async () => {
    const owner = await insertTenant();
    const proposed = `collision-${randomUUID()}@example.test`;
    const change = await emailChange(owner, proposed);
    const other = await pool.query("INSERT INTO exomem_users (email) VALUES ($1) RETURNING id", [
      proposed,
    ]);
    const before = (
      await pool.query(
        "SELECT id, email FROM exomem_users WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[owner.userId, other.rows[0]!.id]]
      )
    ).rows;
    await assert.rejects(completeExomemEmailChange("confirm", change.confirm), {
      code: "ACCESS_TOKEN_INVALID",
    });
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id, email FROM exomem_users WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[owner.userId, other.rows[0]!.id]]
        )
      ).rows,
      before
    );
  });

  it("serializes confirmation against cancellation so exactly one capability wins", async () => {
    const owner = await insertTenant();
    const original = (
      await pool.query("SELECT email FROM exomem_users WHERE id = $1", [owner.userId])
    ).rows[0]!.email;
    const proposed = `race-${randomUUID()}@example.test`;
    const change = await emailChange(owner, proposed);
    const results = await Promise.allSettled([
      completeExomemEmailChange("confirm", change.confirm),
      completeExomemEmailChange("cancel", change.cancel),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const confirmed = results[0]!.status === "fulfilled";
    assert.equal(
      (await pool.query("SELECT email FROM exomem_users WHERE id = $1", [owner.userId])).rows[0]!
        .email,
      confirmed ? proposed : original
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM exomem_paddle_receipt_contacts WHERE tenant_id = $1",
          [owner.tenantId]
        )
      ).rows[0]!.n,
      confirmed ? 1 : 0
    );
  });

  it("allows only one of two concurrent confirmations to claim the same canonical address", async () => {
    const first = await insertTenant();
    const second = await insertTenant();
    const proposed = `concurrent-${randomUUID()}@example.test`;
    const one = await emailChange(first, proposed);
    const two = await emailChange(second, proposed);
    const results = await Promise.allSettled([
      completeExomemEmailChange("confirm", one.confirm),
      completeExomemEmailChange("confirm", two.confirm),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM exomem_users WHERE email = $1", [proposed]))
        .rows[0]!.n,
      1
    );
  });

  it("verifies a lost customer PATCH response by independent readback and keeps the actual observation", async () => {
    const owner = await receiptOwner();
    let remote = "previous-receipt@example.test";
    let patches = 0;
    const calls: string[] = [];
    const config = loadExomemPaddleConfig({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    });
    const transport = async (path: string, init?: RequestInit) => {
      assert.equal(path, `/customers/${owner.customerId}`);
      calls.push(init?.method ?? "GET");
      if (init?.method === "PATCH") {
        patches += 1;
        assert.deepEqual(JSON.parse(String(init.body)), { email: owner.desired });
        remote = owner.desired;
        throw new Error("response lost");
      }
      return Response.json({ data: { id: owner.customerId, email: remote } });
    };
    assert.equal(
      (await runBoundedPaddleReceiptContacts({}, { config, transport })).synchronized,
      1
    );
    assert.deepEqual(calls, ["GET", "PATCH", "GET"]);
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
    assert.equal(patches, 1);
    const known = await loadPaddleReceiptContact(owner);
    assert.equal(known?.knownEmail, owner.desired);
    assert.equal(known?.observationSource, "paddle_customer");
    assert.ok(known?.observedAt);
  });

  it("honors failed-read backoff without claiming verification and wakes for a changed customer", async () => {
    const owner = await receiptOwner();
    const config = loadExomemPaddleConfig({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    });
    let customerId = owner.customerId;
    let unavailable = true;
    let calls = 0;
    const transport = async (path: string) => {
      assert.equal(path, `/customers/${customerId}`);
      calls += 1;
      return unavailable
        ? Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 })
        : Response.json({ data: { id: customerId, email: owner.desired } });
    };
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).pending, 1);
    assert.equal((await loadPaddleReceiptContact(owner))?.knownEmail, null);
    assert.equal((await loadPaddleReceiptContact(owner))?.observedAt, null);
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
    assert.equal(calls, 1, "an unknown observation does not bypass retry backoff");

    customerId = `ctm_${randomBytes(13).toString("hex")}`;
    await pool.query(
      "UPDATE exomem_entitlements SET provider_customer_ref = $2 WHERE tenant_id = $1",
      [owner.tenantId, customerId]
    );
    unavailable = false;
    assert.equal(
      (await runBoundedPaddleReceiptContacts({}, { config, transport })).synchronized,
      1
    );
    const observed = await loadPaddleReceiptContact(owner);
    assert.equal(observed?.knownEmail, owner.desired);
    assert.equal(observed?.observationSource, "paddle_customer");
    assert.ok(observed?.observedAt);

    await pool.query(
      "UPDATE exomem_paddle_receipt_contacts SET next_attempt_at = now() WHERE tenant_id = $1",
      [owner.tenantId]
    );
    unavailable = true;
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).pending, 1);
    const retained = await loadPaddleReceiptContact(owner);
    assert.equal(retained?.knownEmail, observed?.knownEmail);
    assert.equal(retained?.observedAt, observed?.observedAt);
    assert.equal(retained?.observationSource, observed?.observationSource);
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
    assert.equal(calls, 3);
  });

  for (const refusal of [
    { status: 409, code: "customer_already_exists", state: "conflict" },
    { status: 403, code: "forbidden", state: "failed" },
  ]) {
    it(`keeps a ${refusal.status} contact refusal terminal until another confirmed address`, async () => {
      const owner = await receiptOwner();
      const config = loadExomemPaddleConfig({
        PADDLE_ENVIRONMENT: "sandbox",
        PADDLE_API_KEY: "pdl_sdbx_apikey_example",
      });
      let writes = 0;
      const transport = async (path: string, init?: RequestInit) => {
        assert.equal(path, `/customers/${owner.customerId}`);
        if (init?.method === "PATCH") {
          writes += 1;
          return Response.json({ error: { code: refusal.code } }, { status: refusal.status });
        }
        return Response.json({
          data: { id: owner.customerId, email: "known-receipt@example.test" },
        });
      };
      await runBoundedPaddleReceiptContacts({}, { config, transport });
      const known = await loadPaddleReceiptContact(owner);
      assert.equal(known?.state, refusal.state);
      assert.equal(known?.knownEmail, "known-receipt@example.test");
      await pool.query(
        "UPDATE exomem_paddle_receipt_contacts SET next_attempt_at = now() - interval '1 day' WHERE tenant_id = $1",
        [owner.tenantId]
      );
      assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
      assert.equal(writes, 1);
      const next = await emailChange(owner, `recover-${randomUUID()}@example.test`);
      await completeExomemEmailChange("confirm", next.confirm);
      assert.equal((await loadPaddleReceiptContact(owner))?.state, "pending");
    });
  }

  it("holds one contact lease across two cron contenders and skips PATCH after a new confirmation", async () => {
    const owner = await receiptOwner();
    const config = loadExomemPaddleConfig({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    });
    let reached!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let patches = 0;
    const first = runBoundedPaddleReceiptContacts(
      {},
      {
        config,
        transport: async (_path, init) => {
          if (init?.method === "PATCH") patches += 1;
          reached();
          await held;
          return Response.json({ data: { id: owner.customerId, email: "previous@example.test" } });
        },
      }
    );
    await reading;
    try {
      const contender = await runBoundedPaddleReceiptContacts(
        {},
        {
          config,
          transport: async () => {
            throw new Error("another worker already holds the lease");
          },
        }
      );
      assert.equal(contender.attempted, 0);
      const next = await emailChange(owner, `latest-${randomUUID()}@example.test`);
      await completeExomemEmailChange("confirm", next.confirm);
    } finally {
      release();
    }
    assert.equal((await first).superseded, 1);
    assert.equal(patches, 0);
  });

  it("rejects a stale PATCH completion and repairs a late provider write on the targeted recheck", async () => {
    const owner = await receiptOwner();
    const config = loadExomemPaddleConfig({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    });
    let remote = "previous@example.test";
    let reached!: () => void;
    let release!: () => void;
    const patching = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = true;
    const transport = async (_path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        if (hold) {
          hold = false;
          reached();
          await held;
        }
        remote = JSON.parse(String(init.body)).email;
      }
      return Response.json({ data: { id: owner.customerId, email: remote } });
    };
    const first = runBoundedPaddleReceiptContacts({}, { config, transport });
    await patching;
    const latest = `latest-${randomUUID()}@example.test`;
    try {
      const next = await emailChange(owner, latest);
      await completeExomemEmailChange("confirm", next.confirm);
    } finally {
      release();
    }
    assert.equal((await first).superseded, 1);
    assert.equal((await loadPaddleReceiptContact(owner))?.knownEmail, null);
    await pool.query(
      "UPDATE exomem_paddle_receipt_contacts SET lease_expires_at = now() - interval '1 second' WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.equal(
      (await runBoundedPaddleReceiptContacts({}, { config, transport })).synchronized,
      1
    );
    assert.equal(remote, latest);
    remote = owner.desired;
    await pool.query(
      "UPDATE exomem_paddle_receipt_contacts SET next_attempt_at = now() WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.equal(
      (await runBoundedPaddleReceiptContacts({}, { config, transport })).synchronized,
      1
    );
    assert.equal(remote, latest);
  });

  for (const source of ["webhook", "checkout"] as const) {
    it(`activates an unbound intent when ${source} later binds its existing customer`, async () => {
      const owner = await receiptOwner(false);
      const config = loadExomemPaddleConfig({
        PADDLE_ENVIRONMENT: "sandbox",
        PADDLE_API_KEY: "pdl_sdbx_apikey_example",
      });
      const transport = async () =>
        Response.json({ data: { id: owner.customerId, email: owner.desired } });
      assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
      if (source === "webhook") {
        const event = subscriptionEvent(owner, {
          occurredAt: "2026-10-10T00:00:00Z",
          status: "active",
        });
        (event.data as Record<string, unknown>).customer_id = owner.customerId;
        assert.deepEqual(await dispatch(event), { kind: "handled", outcome: "applied" });
      } else {
        const transactionId = `txn_${randomBytes(13).toString("hex")}`;
        await pool.query(
          "UPDATE exomem_entitlements SET provider_transaction_ref = $2, provider_subscription_ref = NULL, source_state = 'checkout_pending' WHERE tenant_id = $1",
          [owner.tenantId, transactionId]
        );
        assert.equal(
          await promoteExomemCheckoutSubscription({
            ...owner,
            transactionId,
            subscriptionId: owner.subscriptionId,
            customerId: owner.customerId,
            environment: "sandbox",
          }),
          true
        );
      }
      assert.equal(
        (await runBoundedPaddleReceiptContacts({}, { config, transport })).synchronized,
        1
      );
      assert.equal((await loadPaddleReceiptContact(owner))?.knownEmail, owner.desired);
    });
  }

  it("does not call a customer without matching proven environment and binding", async () => {
    const owner = await receiptOwner();
    const config = loadExomemPaddleConfig({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    });
    let calls = 0;
    const transport = async () => {
      calls += 1;
      throw new Error("no proven matching binding");
    };
    await pool.query(
      "UPDATE exomem_entitlements SET provider_environment = NULL, provider_provenance_unresolved_fingerprint = COALESCE(provider_customer_ref, '') || chr(31) || COALESCE(provider_subscription_ref, '') || chr(31) || COALESCE(provider_transaction_ref, '') WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
    await pool.query(
      "UPDATE exomem_entitlements SET provider_environment = 'production', provider_provenance_unresolved_fingerprint = NULL WHERE tenant_id = $1",
      [owner.tenantId]
    );
    assert.equal((await runBoundedPaddleReceiptContacts({}, { config, transport })).attempted, 0);
    assert.equal(calls, 0);
    assert.equal((await loadPaddleReceiptContact(owner))?.knownEmail, null);
  });

  it("preserves fresh same-transaction re-admission state when an old receipt completion arrives", async () => {
    const owner = await receiptOwner();
    const oldPending = await emailChange(owner, `old-pending-${randomUUID()}@example.test`);
    const config = loadExomemPaddleConfig({
      PADDLE_ENVIRONMENT: "sandbox",
      PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    });
    let reached!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldWorker = runBoundedPaddleReceiptContacts(
      {},
      {
        config,
        transport: async (_path, init) => {
          assert.equal(init?.method, "GET");
          reached();
          await held;
          return Response.json({ data: { id: owner.customerId, email: owner.desired } });
        },
      }
    );
    await reading;
    const freshRevision = randomUUID();
    const freshRequest = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
        [owner.tenantId]
      );
      await client.query(
        "UPDATE exomem_tenants SET status = 'active', desired_state = 'running', deleted_at = NULL WHERE id = $1",
        [owner.tenantId]
      );
      await client.query(
        "INSERT INTO exomem_paddle_receipt_contacts (tenant_id, desired_revision) VALUES ($1, $2)",
        [owner.tenantId, freshRevision]
      );
      await client.query(
        "INSERT INTO exomem_email_changes (tenant_id, id, original_email, proposed_email, confirmation_digest, cancellation_digest, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '15 minutes')",
        [
          owner.tenantId,
          freshRequest,
          owner.desired,
          `fresh-${randomUUID()}@example.test`,
          randomBytes(32),
          randomBytes(32),
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      release();
    }
    assert.equal((await oldWorker).superseded, 1);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT desired_revision, observed_email, lease_owner FROM exomem_paddle_receipt_contacts WHERE tenant_id = $1",
          [owner.tenantId]
        )
      ).rows,
      [{ desired_revision: freshRevision, observed_email: null, lease_owner: null }]
    );
    assert.equal(
      (
        await pool.query("SELECT id FROM exomem_email_changes WHERE tenant_id = $1", [
          owner.tenantId,
        ])
      ).rows[0]!.id,
      freshRequest
    );
    await assert.rejects(completeExomemEmailChange("confirm", oldPending.confirm), {
      code: "ACCESS_TOKEN_INVALID",
    });
  });
});
