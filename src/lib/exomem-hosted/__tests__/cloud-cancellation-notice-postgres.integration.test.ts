import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import {
  retryPendingCloudCancellationNotices,
  sendCloudCancellationNoticeOnce,
} from "../cloud-cancellation-notice";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { drainExomemEmailOutbox } from "../email-outbox";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The lifecycle emails this suite's facts enqueue carry an encrypted payload.
process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

// Item 5 / task 3.7: the cancellation notice's claim is idempotent under
// redelivery -- one claim per ended period, against real PostgreSQL's own
// column-level dedupe (migration 0057) -- and the claim's transaction queues
// email 05, and email 06 for a week before deletion, in the email outbox.

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

type QueuedEmail = { kind: string; state: string; notBefore: Date };

async function queuedFor(email: string): Promise<QueuedEmail[]> {
  const { rows } = await pool!.query<{ kind: string; state: string; not_before: Date }>(
    "SELECT kind, state, not_before FROM exomem_email_outbox WHERE recipient = $1 ORDER BY not_before",
    [email]
  );
  return rows.map((row) => ({ kind: row.kind, state: row.state, notBefore: row.not_before }));
}

async function resetFleet(): Promise<void> {
  await pool!.query("DELETE FROM exomem_email_outbox");
  await pool!.query("DELETE FROM exomem_entitlements");
  await pool!.query("DELETE FROM exomem_cloud_cells");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM users");
}

/** A cancellation still inside its 30-day export window. */
const RECENT_CANCELLATION = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

async function seedTenant(input: {
  desiredState?: "running" | "read_only" | "stopped" | "deleted";
  /** The entitlement's Paddle state; `null` seeds no entitlement at all. */
  sourceState?: string | null;
  sourceOccurredAt?: Date;
} = {}): Promise<{ tenantId: string; email: string; cellId: string }> {
  const email = `cloud-cancellation-${randomUUID()}@example.test`;
  const userResult = await pool!.query(
    "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
    [email]
  );
  const userId = userResult.rows[0].id as string;
  const tenantResult = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [userId]
  );
  const tenantId = tenantResult.rows[0].id as string;
  const cellId = randomCloudCellId();
  await pool!.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, input.desiredState ?? "read_only"]
  );
  if (input.sourceState !== null) {
    await pool!.query(
      `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state, source_occurred_at)
       VALUES ($1, 'paddle', $2, 'active', $3)`,
      [tenantId, input.sourceState ?? "cancelled", input.sourceOccurredAt ?? RECENT_CANCELLATION]
    );
  }
  return { tenantId, email, cellId };
}

describe("Exomem Cloud cancellation notice PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `cloud_cancellation_it_${randomUUID().replaceAll("-", "")}`;
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
  });

  beforeEach(async () => {
    await resetFleet();
  });

  const DAY = 24 * 60 * 60 * 1000;

  it("queues the ended email once under redelivery: the same tenant, called twice, queues only the first time", async () => {
    const { tenantId, email } = await seedTenant();

    const first = await sendCloudCancellationNoticeOnce(tenantId, RECENT_CANCELLATION);
    const second = await sendCloudCancellationNoticeOnce(tenantId, RECENT_CANCELLATION);

    assert.equal(first, true);
    assert.equal(second, false);
    const queued = await queuedFor(email);
    assert.deepEqual(
      queued.map((row) => [row.kind, row.state]),
      [
        ["subscription_ended", "pending"],
        ["deletion_reminder", "pending"],
      ]
    );
    // 30 days kept from the cancellation, reminded 7 days before the end.
    assert.equal(
      queued[1]!.notBefore.getTime(),
      RECENT_CANCELLATION.getTime() + 23 * DAY
    );
  });

  // Security review finding 9c: the deletion date in the email is computed
  // from the entitlement's own cancellation timestamp, not from whenever the
  // send happens to run -- matching desiredCloudCellState's own 30-day
  // export-window arithmetic exactly.
  it("dates the deletion from the cancellation, not from the send", async () => {
    const cancelledAt = new Date("2026-10-01T12:00:00.000Z");
    const { tenantId } = await seedTenant({ sourceOccurredAt: cancelledAt });
    await sendCloudCancellationNoticeOnce(tenantId, cancelledAt, {
      now: () => new Date("2026-10-02T12:00:00.000Z"),
    });
    const sent: string[] = [];
    const drained = await drainExomemEmailOutbox(
      {},
      {
        sendEmail: async (input) => {
          sent.push(input.textContent);
          return { success: true };
        },
      }
    );
    assert.equal(drained.sent, 1);
    // 2026-10-01 + 30 days = 31 October, in UTC because no zone is stored.
    assert.match(sent[0]!, /It’s read-only until 31 October \(UTC\)\./);
  });

  it("queues no week-before reminder when less than a week is left", async () => {
    const lateCancellation = new Date(Date.now() - 25 * DAY);
    const { tenantId, email } = await seedTenant({ sourceOccurredAt: lateCancellation });
    assert.equal(await sendCloudCancellationNoticeOnce(tenantId, lateCancellation), true);
    assert.deepEqual(
      (await queuedFor(email)).map((row) => row.kind),
      ["subscription_ended"]
    );
  });

  it("cancels the queued emails when the owner resubscribes before they go out", async () => {
    const { tenantId, email, cellId } = await seedTenant();
    await sendCloudCancellationNoticeOnce(tenantId, RECENT_CANCELLATION);
    // Resubscribed: the entitlement is active again and the cell runs, which
    // clears the claim (cloud-lifecycle.ts).
    await pool!.query("UPDATE exomem_entitlements SET source_state = 'active' WHERE tenant_id = $1", [
      tenantId,
    ]);
    await pool!.query(
      "UPDATE exomem_cloud_cells SET desired_state = 'running', cancellation_notice_sent_at = NULL WHERE cell_id = $1",
      [cellId]
    );
    // The reminder is due later; bring it forward so this drain reaches it too.
    await pool!.query("UPDATE exomem_email_outbox SET not_before = now() WHERE recipient = $1", [
      email,
    ]);
    const drained = await drainExomemEmailOutbox(
      {},
      {
        sendEmail: async () => {
          throw new Error("must not be called");
        },
      }
    );
    assert.equal(drained.cancelled, 2);
    assert.deepEqual(
      (await queuedFor(email)).map((row) => row.state),
      ["cancelled", "cancelled"]
    );
  });

  // Cloud design D4: the periodic sweep retries the notice for any cancelled
  // read_only row whose claim is null, so a missed webhook is not the end.
  it("retries the notice for a cancelled read_only cell whose claim is null, and only for those", async () => {
    async function withEntitlement(
      desiredState: "running" | "read_only",
      sourceState: string,
      claimed = false
    ): Promise<{ tenantId: string; email: string }> {
      const seeded = await seedTenant({ desiredState, sourceState });
      if (claimed) {
        await pool!.query(
          "UPDATE exomem_cloud_cells SET cancellation_notice_sent_at = now() WHERE tenant_id = $1",
          [seeded.tenantId]
        );
      }
      return seeded;
    }
    const pending = await withEntitlement("read_only", "cancelled");
    const claimed = await withEntitlement("read_only", "cancelled", true);
    const pastDue = await withEntitlement("read_only", "past_due");
    const active = await withEntitlement("running", "active");

    const result = await retryPendingCloudCancellationNotices();
    assert.deepEqual(result, { attempted: 1, sent: 1 });
    assert.equal((await queuedFor(pending.email)).length, 2);
    for (const other of [claimed, pastDue, active]) {
      assert.deepEqual(await queuedFor(other.email), []);
    }

    // Nothing is left to retry, so a second sweep queues nothing.
    assert.deepEqual(await retryPendingCloudCancellationNotices(), { attempted: 0, sent: 0 });
  });

  // A retry batch can reach a tenant who resubscribed since it was listed:
  // the claim itself re-checks that the cell is still cancelled read_only,
  // so nothing is queued and no stale claim is left on a running cell.
  it("never claims a notice for a cell that is no longer cancelled read_only", async () => {
    const running = await seedTenant({ desiredState: "running", sourceState: "active" });
    const readOnlyActive = await seedTenant({ desiredState: "read_only", sourceState: "past_due" });
    for (const seeded of [running, readOnlyActive]) {
      assert.equal(await sendCloudCancellationNoticeOnce(seeded.tenantId, RECENT_CANCELLATION), false);
      assert.deepEqual(await queuedFor(seeded.email), []);
      const { rows } = await pool!.query(
        "SELECT cancellation_notice_sent_at FROM exomem_cloud_cells WHERE cell_id = $1",
        [seeded.cellId]
      );
      assert.equal(rows[0]!.cancellation_notice_sent_at, null);
    }
  });

  it("never retries a notice whose export window has already ended", async () => {
    const lapsed = new Date(Date.now() - 45 * DAY);
    await seedTenant({ sourceOccurredAt: lapsed });
    assert.deepEqual(await retryPendingCloudCancellationNotices(), { attempted: 0, sent: 0 });
  });

  it("queues nothing for a tenant with no live Cloud cell", async () => {
    assert.equal(await sendCloudCancellationNoticeOnce(randomUUID(), RECENT_CANCELLATION), false);
    const { tenantId, email } = await seedTenant({ desiredState: "deleted" });
    assert.equal(await sendCloudCancellationNoticeOnce(tenantId, RECENT_CANCELLATION), false);
    assert.deepEqual(await queuedFor(email), []);
  });
});
