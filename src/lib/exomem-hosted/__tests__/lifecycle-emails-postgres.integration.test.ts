import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { sendCloudCancellationNoticeOnce } from "../cloud-cancellation-notice";
import { finishCloudAccountDeletion } from "../cloud-deletion-finish";
import { reconcileCloudCellDesiredState } from "../cloud-lifecycle";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  createDeletionConfirmationToken,
  type ExomemSql,
} from "../db";
import { confirmDeletion } from "../deletion";
import {
  drainExomemEmailOutbox,
  EXOMEM_EMAIL_KINDS,
  sealExomemEmailPayload,
} from "../email-outbox";
import { createSqlExomemPaddleEventStore } from "../paddle-event-store";
import type { ExomemPaddleEventApplication } from "../paddle-webhook";
import { generateExternalToken, tokenDigest } from "../security";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The account lifecycle emails against real PostgreSQL: each is queued once with
// the fact it announces, and cancelled at send when that fact no longer holds.

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const MIGRATIONS = resolve(process.cwd(), "migrations");
const LIFECYCLE_EMAILS_MIGRATION = "0068_exomem_lifecycle_emails.sql";
const DAY = 24 * 60 * 60 * 1000;

let pool: Pool;
let schema: string;
let migrationsBefore: string;
// Cells that existed when migration 0068 ran.
let startedBeforeDeploy: { email: string; cellId: string };
let neverStartedAtDeploy: { email: string; cellId: string };
let inHoldAtDeploy: { email: string; cellId: string; tenantId: string };
let reviewerAtDeploy: { email: string; cellId: string };
// A never-paid hold whose reminder was queued before 0068 added the tenant column.
let heldWithReminderAtDeploy: { email: string; userId: string; tenantId: string; cellId: string };

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
  const client = await pool.connect();
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

async function seedTenant(input: {
  source: "paddle" | "complimentary";
  sourceState: string;
  cell: "running" | "read_only" | "stopped";
  sourceOccurredAt?: Date;
  marketplaceReviewer?: boolean;
}): Promise<{
  email: string;
  userId: string;
  tenantId: string;
  cellId: string;
  subscriptionId: string;
}> {
  const email = `lifecycle-${randomUUID()}@example.test`;
  const user = await pool.query("INSERT INTO users (email) VALUES ($1) RETURNING id", [email]);
  const userId = String(user.rows[0].id);
  const tenant = await pool.query(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose)
     VALUES ($1, 'active', 'running', $2) RETURNING id`,
    [userId, input.marketplaceReviewer ?? false]
  );
  const tenantId = String(tenant.rows[0].id);
  const subscriptionId = `sub_${randomUUID().replaceAll("-", "")}`;
  await pool.query(
    `INSERT INTO exomem_entitlements (
       tenant_id, source, source_state, effective_state, provider_environment,
       provider_subscription_ref, source_occurred_at, source_revision
     ) VALUES ($1, $2, $3, 'active', $4, $5, $6, 'evt_initial')`,
    [
      tenantId,
      input.source,
      input.sourceState,
      input.source === "paddle" ? "sandbox" : null,
      input.source === "paddle" ? subscriptionId : null,
      input.sourceOccurredAt ?? new Date("2026-09-01T00:00:00Z"),
    ]
  );
  const cellId = randomCloudCellId();
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, input.cell]
  );
  return { email, userId, tenantId, cellId, subscriptionId };
}

/** What cellctl writes once a cell has started. */
async function markReady(cellId: string): Promise<void> {
  await pool.query(
    "UPDATE exomem_cloud_cells SET desired_state = 'running', observed_state = 'running', ready = true WHERE cell_id = $1",
    [cellId]
  );
}

async function queued(email: string): Promise<Array<{ kind: string; state: string }>> {
  const { rows } = await pool.query<{ kind: string; state: string }>(
    "SELECT kind, state FROM exomem_email_outbox WHERE recipient = $1 ORDER BY created_at",
    [email]
  );
  return rows;
}

type Sent = { to: string; subject: string; textContent: string; senderName?: string };

async function drain(): Promise<{ sent: Sent[]; cancelled: number; deferred: number }> {
  const sent: Sent[] = [];
  const result = await drainExomemEmailOutbox(
    {},
    {
      sendEmail: async (input) => {
        sent.push(input);
        return { success: true };
      },
    }
  );
  return { sent, cancelled: result.cancelled, deferred: result.deferred };
}

/** What cellctl writes once it has deleted every cell of a tenant. */
async function markCellsDeleted(tenantId: string): Promise<void> {
  await pool.query(
    `UPDATE exomem_cloud_cells
     SET observed_state = 'deleted', observed_generation = generation, ready = false,
         observed_at = now()
     WHERE tenant_id = $1`,
    [tenantId]
  );
}

/** A hold reminder as admission queued it before migration 0068: no tenant column. */
async function queueLegacyHoldReminder(
  tenant: { email: string; cellId: string },
  state: "pending" | "sent"
): Promise<void> {
  if (state === "sent") {
    await pool.query(
      `INSERT INTO exomem_email_outbox (kind, dedupe_key, recipient, recipient_time_zone, state, sent_at)
       VALUES ('hold_reminder', $1, $2, 'Europe/Berlin', 'sent', now())`,
      [`hold-reminder:${tenant.cellId}`, tenant.email]
    );
    return;
  }
  const payload = sealExomemEmailPayload("hold_reminder", {
    version: 1,
    cellId: tenant.cellId,
    holdEndsAt: new Date(Date.now() + 7 * DAY).toISOString(),
    inviterName: null,
  });
  await pool.query(
    `INSERT INTO exomem_email_outbox (
       kind, dedupe_key, recipient, recipient_time_zone, payload_ciphertext, not_before, expires_at
     ) VALUES ('hold_reminder', $1, $2, 'Europe/Berlin', $3::jsonb,
               now() + interval '5 days', now() + interval '7 days')`,
    [`hold-reminder:${tenant.cellId}`, tenant.email, payload]
  );
}

/** The clock reaches every waiting email of a tenant. */
async function dueNow(tenantId: string): Promise<void> {
  await pool.query(
    "UPDATE exomem_email_outbox SET not_before = now() WHERE tenant_id = $1 AND state = 'pending'",
    [tenantId]
  );
}

async function deletedReceipts(tenantId: string): Promise<Array<{ state: string }>> {
  const { rows } = await pool.query<{ state: string }>(
    "SELECT state FROM exomem_email_outbox WHERE kind = 'deleted' AND tenant_id = $1",
    [tenantId]
  );
  return rows;
}

function pastDueEvent(
  tenant: { userId: string; tenantId: string; subscriptionId: string },
  input: { eventId: string; occurredAt: string; sourceState: "past_due" | "active" }
): ExomemPaddleEventApplication {
  return {
    eventId: input.eventId,
    eventType:
      input.sourceState === "past_due" ? "subscription.past_due" : "subscription.activated",
    environment: "sandbox",
    origin: "webhook",
    revision: { occurredAt: input.occurredAt, eventId: input.eventId },
    correlation: { productKey: "exomem-hosted", userId: tenant.userId, tenantId: tenant.tenantId },
    sourceState: input.sourceState,
    capabilities: ["capture", "recall", "export"],
    resourceLimits: { storageBytes: 1, uploadBytes: 1, workerCount: 0 },
    providerReferences: {
      customerId: null,
      subscriptionId: tenant.subscriptionId,
      transactionId: null,
      productId: null,
      priceId: null,
    },
    subscriptionFacts: {
      priceName: null,
      nextBilledAt: null,
      discountId: null,
      scheduledChangeAt: null,
    },
    subscriptionCarriesFriendDiscount: false,
  };
}

describe("Exomem lifecycle emails on PostgreSQL", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `lifecycle_emails_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);

    // Upgrade a populated database: every migration before 0068, then cells, then 0068.
    migrationsBefore = mkdtempSync(join(tmpdir(), "exomem-lifecycle-emails-migrations-"));
    for (const name of readdirSync(MIGRATIONS).filter(
      (file) => file < LIFECYCLE_EMAILS_MIGRATION
    )) {
      copyFileSync(join(MIGRATIONS, name), join(migrationsBefore, name));
    }
    await applyMigrations({ databaseUrl: scoped.toString(), migrationsDir: migrationsBefore });
    pool = new Pool({ connectionString: scoped.toString() });
    startedBeforeDeploy = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "running",
    });
    await markReady(startedBeforeDeploy.cellId);
    // Admitted, but cellctl has not started it yet.
    neverStartedAtDeploy = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "running",
    });
    inHoldAtDeploy = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      cell: "stopped",
    });
    reviewerAtDeploy = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "stopped",
      marketplaceReviewer: true,
    });
    heldWithReminderAtDeploy = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      cell: "stopped",
    });
    // A hold that was never paid has no provider subscription yet.
    await pool.query(
      "UPDATE exomem_entitlements SET provider_subscription_ref = NULL, provider_environment = NULL WHERE tenant_id = $1",
      [heldWithReminderAtDeploy.tenantId]
    );
    await queueLegacyHoldReminder(heldWithReminderAtDeploy, "pending");
    await queueLegacyHoldReminder(inHoldAtDeploy, "sent");
    await applyMigrations({ databaseUrl: scoped.toString() });

    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    rmSync(migrationsBefore, { recursive: true, force: true });
  });

  it("allows in the outbox's kind CHECK exactly the kinds the outbox can send", async () => {
    // A migration that replaces the CHECK and drops an earlier migration's kinds, or a
    // kind added in code without a migration, fails here instead of at its first send.
    const { rows } = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'exomem_email_outbox'::regclass
         AND conname = 'exomem_email_outbox_kind_check'`
    );
    const definition = rows[0]!.definition;
    // PostgreSQL prints this CHECK in one canonical shape; reading the quoted names
    // of that printed shape is a format check, and any other shape fails the match.
    assert.match(definition, /^CHECK \(\(kind = ANY \(ARRAY\[('[a-z_]+'::text(, )?)+\]\)\)\)$/);
    const allowed = [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
    assert.deepEqual([...allowed].sort(), [...EXOMEM_EMAIL_KINDS].sort());
  });

  it("03: welcomes a cell the first time it is ready, but never one that had started before deploy or a reviewer's", async () => {
    // The cells that existed at deploy are ready now: one was still starting,
    // and the held one was paid for.
    await pool.query(
      "UPDATE exomem_entitlements SET source_state = 'active' WHERE tenant_id = $1",
      [inHoldAtDeploy.tenantId]
    );
    await markReady(neverStartedAtDeploy.cellId);
    await markReady(inHoldAtDeploy.cellId);
    const admittedAfterDeploy = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "running",
    });
    await markReady(admittedAfterDeploy.cellId);
    // A marketplace reviewer's tenant is a review fixture: no welcome, before or after deploy.
    const reviewerAfterDeploy = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "running",
      marketplaceReviewer: true,
    });
    await markReady(reviewerAtDeploy.cellId);
    await markReady(reviewerAfterDeploy.cellId);

    const first = await drain();
    const second = await drain();

    assert.deepEqual(
      first.sent.map((email) => [email.to, email.subject]).sort(),
      [
        [admittedAfterDeploy.email, "Your Exomem is ready"],
        [neverStartedAtDeploy.email, "Your Exomem is ready"],
        [inHoldAtDeploy.email, "Your Exomem is ready"],
      ].sort()
    );
    assert.deepEqual(second.sent, []);
    assert.deepEqual(await queued(startedBeforeDeploy.email), []);
    assert.deepEqual(await queued(reviewerAtDeploy.email), []);
    assert.deepEqual(await queued(reviewerAfterDeploy.email), []);
    // The covered Exomem has no Paddle line; the paid one does.
    const covered = first.sent.find((email) => email.to === admittedAfterDeploy.email)!;
    assert.doesNotMatch(covered.textContent, /Paddle/);
  });

  it("03: cancels the welcome when the cell stopped being ready before it went out", async () => {
    const tenant = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "running",
    });
    await markReady(tenant.cellId);
    // Queue it without sending, then the cell goes down.
    const { enqueueReadyEmails } = await import("../lifecycle-emails");
    assert.deepEqual(await enqueueReadyEmails(), { enqueued: 1 });
    await pool.query("UPDATE exomem_cloud_cells SET ready = false WHERE cell_id = $1", [
      tenant.cellId,
    ]);

    const result = await drain();

    assert.deepEqual(result.sent, []);
    assert.deepEqual(await queued(tenant.email), [{ kind: "ready", state: "cancelled" }]);
  });

  it("04: queues the payment email in the statement that starts past due, once per period, and drops it on recovery", async () => {
    const store = createSqlExomemPaddleEventStore(taggedSql(pool));
    const tenant = await seedTenant({ source: "paddle", sourceState: "active", cell: "running" });

    await store.applyVerifiedEventAndMarkProcessedAtomically(
      pastDueEvent(tenant, {
        eventId: "evt_past_due_1",
        occurredAt: "2026-10-02T10:00:00.000Z",
        sourceState: "past_due",
      })
    );
    await store.applyVerifiedEventAndMarkProcessedAtomically(
      pastDueEvent(tenant, {
        eventId: "evt_past_due_2",
        occurredAt: "2026-10-03T10:00:00.000Z",
        sourceState: "past_due",
      })
    );
    assert.deepEqual(await queued(tenant.email), [{ kind: "payment_failed", state: "pending" }]);

    const previous = process.env.EXOMEM_PADDLE_DUNNING_DAYS;
    process.env.EXOMEM_PADDLE_DUNNING_DAYS = "14";
    try {
      const sent = (await drain()).sent;
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.subject, "Your payment didn’t go through");
      // Grace started 2 October; 14 dunning days later, in UTC because no zone is stored.
      assert.match(sent[0]!.textContent, /by 16 October \(UTC\), your subscription ends\./);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PADDLE_DUNNING_DAYS;
      else process.env.EXOMEM_PADDLE_DUNNING_DAYS = previous;
    }

    // A second period after recovery gets its own email, which recovery then cancels.
    await store.applyVerifiedEventAndMarkProcessedAtomically(
      pastDueEvent(tenant, {
        eventId: "evt_recovered",
        occurredAt: "2026-10-04T10:00:00.000Z",
        sourceState: "active",
      })
    );
    await store.applyVerifiedEventAndMarkProcessedAtomically(
      pastDueEvent(tenant, {
        eventId: "evt_past_due_3",
        occurredAt: "2026-10-20T10:00:00.000Z",
        sourceState: "past_due",
      })
    );
    await store.applyVerifiedEventAndMarkProcessedAtomically(
      pastDueEvent(tenant, {
        eventId: "evt_recovered_2",
        occurredAt: "2026-10-21T10:00:00.000Z",
        sourceState: "active",
      })
    );
    const afterRecovery = await drain();
    assert.deepEqual(afterRecovery.sent, []);
    assert.deepEqual(await queued(tenant.email), [
      { kind: "payment_failed", state: "sent" },
      { kind: "payment_failed", state: "cancelled" },
    ]);
  });

  it("03, 04 and 05: go to the owner's address when they are sent, not the one they were queued for", async () => {
    const store = createSqlExomemPaddleEventStore(taggedSql(pool));
    const ready = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      cell: "running",
    });
    await markReady(ready.cellId);
    const { enqueueReadyEmails } = await import("../lifecycle-emails");
    await enqueueReadyEmails();
    const pastDue = await seedTenant({ source: "paddle", sourceState: "active", cell: "running" });
    await store.applyVerifiedEventAndMarkProcessedAtomically(
      pastDueEvent(pastDue, {
        eventId: `evt_${randomUUID()}`,
        occurredAt: new Date(Date.now() - DAY).toISOString(),
        sourceState: "past_due",
      })
    );
    const cancelledAt = new Date(Date.now() - DAY);
    const ended = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      cell: "read_only",
      sourceOccurredAt: cancelledAt,
    });
    assert.equal(await sendCloudCancellationNoticeOnce(ended.tenantId, cancelledAt), true);
    // Each owner moves to a new address before anything goes out.
    const moved = new Map<string, string>();
    for (const tenant of [ready, pastDue, ended]) {
      const address = `moved-${randomUUID()}@example.test`;
      await pool.query("UPDATE users SET email = $1 WHERE id = $2", [address, tenant.userId]);
      moved.set(tenant.email, address);
    }

    const sent = (await drain()).sent;

    assert.deepEqual(
      sent.map((email) => [email.to, email.subject]).sort(),
      [
        [moved.get(ready.email)!, "Your Exomem is ready"],
        [moved.get(pastDue.email)!, "Your payment didn’t go through"],
        [moved.get(ended.email)!, "Your Exomem subscription has ended"],
      ].sort()
    );
    // Each sent row records the address it went to.
    const { rows } = await pool.query<{ recipient: string }>(
      "SELECT recipient::text FROM exomem_email_outbox WHERE state = 'sent' AND tenant_id = ANY($1::uuid[])",
      [[ready.tenantId, pastDue.tenantId, ended.tenantId]]
    );
    assert.deepEqual(rows.map((row) => row.recipient).sort(), [...moved.values()].sort());
  });

  it("06: waits for a week before the current kept-until date when a later provider event moved it", async () => {
    // Cancelled 24 days ago and queued three days ago: the reminder is due.
    const cancelledAt = new Date(Date.now() - 24 * DAY);
    const tenant = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      cell: "read_only",
      sourceOccurredAt: cancelledAt,
    });
    assert.equal(
      await sendCloudCancellationNoticeOnce(tenant.tenantId, cancelledAt, {
        now: () => new Date(Date.now() - 3 * DAY),
      }),
      true
    );
    // A later accepted event moves the cancellation, and the deletion, five days on.
    await pool.query(
      "UPDATE exomem_entitlements SET source_occurred_at = source_occurred_at + interval '5 days' WHERE tenant_id = $1",
      [tenant.tenantId]
    );

    const result = await drain();

    assert.deepEqual(
      result.sent.map((email) => email.subject),
      ["Your Exomem subscription has ended"]
    );
    assert.equal(result.deferred, 1);
    const { rows } = await pool.query<{ state: string; on_time: boolean }>(
      `SELECT outbox.state,
              outbox.not_before = entitlement.source_occurred_at + interval '552 hours' AS on_time
       FROM exomem_email_outbox AS outbox
       JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = outbox.tenant_id
       WHERE outbox.tenant_id = $1 AND outbox.kind = 'deletion_reminder'`,
      [tenant.tenantId]
    );
    assert.deepEqual(rows, [{ state: "pending", on_time: true }]);
  });

  it("07: tells the owner once, after cellctl has deleted the Exomem, with the day cellctl did it", async () => {
    const tenant = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      cell: "read_only",
      sourceOccurredAt: new Date(Date.now() - 32 * DAY),
    });

    // The kept window deleted it yesterday; cellctl finishes today.
    const yesterday = new Date(Date.now() - DAY);
    assert.equal(
      await reconcileCloudCellDesiredState(tenant.tenantId, { now: yesterday }),
      "deleted"
    );
    assert.equal(await reconcileCloudCellDesiredState(tenant.tenantId), null);
    // The vault, its backups and its keys still exist: the email waits, and
    // waiting spends no attempt and runs out no deadline.
    const early = await drain();
    assert.deepEqual(early.sent, []);
    assert.equal(early.deferred, 1);
    const { rows: waiting } = await pool.query(
      "SELECT state, attempts, expires_at FROM exomem_email_outbox WHERE kind = 'deleted' AND tenant_id = $1",
      [tenant.tenantId]
    );
    assert.deepEqual(waiting, [{ state: "pending", attempts: 0, expires_at: null }]);

    await markCellsDeleted(tenant.tenantId);
    await dueNow(tenant.tenantId);
    const sent = (await drain()).sent;

    assert.deepEqual(
      sent.map((email) => [email.to, email.subject]),
      [[tenant.email, "Your Exomem has been deleted"]]
    );
    assert.match(sent[0]!.textContent, /permanently deleted today\./);
  });

  it("07: queues one receipt when two day-30 reconciles overlap", async () => {
    const tenant = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      cell: "read_only",
      sourceOccurredAt: new Date(Date.now() - 31 * DAY),
    });
    // Hold the cell row, so both reconciles read it live and then wait to write it.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM exomem_cloud_cells WHERE cell_id = $1 FOR UPDATE", [
        tenant.cellId,
      ]);
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const reconciles = Promise.all([
        reconcileCloudCellDesiredState(tenant.tenantId),
        reconcileCloudCellDesiredState(tenant.tenantId),
      ]);
      for (let waited = 0; ; waited += 20) {
        const { rows } = await pool.query<{ waiting: number }>(
          `WITH RECURSIVE blocked(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT activity.pid FROM pg_stat_activity AS activity
             JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
           )
           SELECT count(*)::int AS waiting FROM blocked`,
          [holderPid]
        );
        if (rows[0]!.waiting === 2) break;
        assert.ok(waited < 10_000, "sanity: both reconciles reach the cell's lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query("COMMIT");

      assert.deepEqual((await reconciles).sort(), ["deleted", null]);
    } finally {
      holder.release();
    }
    assert.deepEqual(await deletedReceipts(tenant.tenantId), [{ state: "pending" }]);
  });

  it("07: is cancelled when the tenant was re-admitted and deleted again before it went out", async () => {
    const tenant = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      cell: "read_only",
      sourceOccurredAt: new Date(Date.now() - 31 * DAY),
    });
    assert.equal(await reconcileCloudCellDesiredState(tenant.tenantId), "deleted");
    // Re-admission clears the deletion; a later deletion records a new one.
    await pool.query(
      "UPDATE exomem_tenants SET status = 'provisioning', desired_state = 'running', deleted_at = NULL WHERE id = $1",
      [tenant.tenantId]
    );
    await pool.query(
      "UPDATE exomem_tenants SET status = 'deleted', desired_state = 'deleted', deleted_at = now() WHERE id = $1",
      [tenant.tenantId]
    );
    await markCellsDeleted(tenant.tenantId);
    await dueNow(tenant.tenantId);

    const result = await drain();

    assert.deepEqual(result.sent, []);
    assert.deepEqual(await deletedReceipts(tenant.tenantId), [{ state: "cancelled" }]);
  });
  it("account deletion removes a hold reminder queued before migration 0068 to the owner's earlier address", async () => {
    // Migration 0068 gave each reminder queued before it, pending or sent, its cell's tenant.
    const { rows: owned } = await pool.query<{ dedupe_key: string; tenant_id: string }>(
      "SELECT dedupe_key, tenant_id FROM exomem_email_outbox WHERE dedupe_key = ANY($1) ORDER BY dedupe_key",
      [
        [
          `hold-reminder:${heldWithReminderAtDeploy.cellId}`,
          `hold-reminder:${inHoldAtDeploy.cellId}`,
        ],
      ]
    );
    assert.deepEqual(
      owned,
      [
        {
          dedupe_key: `hold-reminder:${heldWithReminderAtDeploy.cellId}`,
          tenant_id: heldWithReminderAtDeploy.tenantId,
        },
        {
          dedupe_key: `hold-reminder:${inHoldAtDeploy.cellId}`,
          tenant_id: inHoldAtDeploy.tenantId,
        },
      ].sort((left, right) => left.dedupe_key.localeCompare(right.dedupe_key))
    );
    const tenant = heldWithReminderAtDeploy;
    const newAddress = `moved-${randomUUID()}@example.test`;
    await pool.query("UPDATE users SET email = $1 WHERE id = $2", [newAddress, tenant.userId]);

    const token = generateExternalToken();
    assert.ok(
      await createDeletionConfirmationToken({
        userId: tenant.userId,
        tenantId: tenant.tenantId,
        tokenDigest: tokenDigest(token)!,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      }),
      "sanity: the owner can request a deletion confirmation"
    );
    await confirmDeletion(
      token,
      { userId: tenant.userId, tenantId: tenant.tenantId },
      { finishCloud: (tenantId) => finishCloudAccountDeletion(tenantId) }
    );

    const { rows: status } = await pool.query("SELECT status FROM exomem_tenants WHERE id = $1", [
      tenant.tenantId,
    ]);
    assert.deepEqual(status, [{ status: "deleted" }]);
    const { rows } = await pool.query<{ kind: string; recipient: string }>(
      "SELECT kind, recipient::text FROM exomem_email_outbox WHERE tenant_id = $1 OR recipient = $2",
      [tenant.tenantId, tenant.email]
    );
    assert.deepEqual(rows, [{ kind: "deleted", recipient: newAddress }]);
  });
});
