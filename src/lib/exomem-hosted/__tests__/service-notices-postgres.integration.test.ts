import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { NextRequest } from "next/server";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { GET, POST } from "../../../app/api/exomem/admin/service-notices/route";
import { randomCloudCellId } from "../cloud-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import { drainExomemEmailOutbox } from "../email-outbox";
import { fanOutServiceNoticeEmails, SERVICE_NOTICE_FANOUT_BATCH } from "../service-notice-fanout";
import { createNoticeCache, loadOpenServiceNotices } from "../service-notice-header";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Service notices against real PostgreSQL: the operator route, then (in the same
// schema) the email fan-out. Each test names a failure that only a real database shows.

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");
const ADMIN_TOKEN = randomBytes(32).toString("base64url");

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;

let pool: Pool;
let schema: string;

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

/** One tenant: an owner with an email address and a cell. */
async function seedTenant(
  options: {
    cell?: "running" | "deleted";
    reviewer?: boolean;
    status?: "active" | "deletion_pending";
    timeZone?: string;
  } = {}
): Promise<{ email: string; tenantId: string; cellId: string }> {
  const email = `notice-${randomUUID()}@example.test`;
  const user = await pool.query("INSERT INTO exomem_users (email) VALUES ($1) RETURNING id", [
    email,
  ]);
  const tenant = await pool.query(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, marketplace_reviewer_purpose, time_zone)
     VALUES ($1, $2, 'running', $3, $4) RETURNING id`,
    [
      user.rows[0].id,
      options.status ?? "active",
      options.reviewer ?? false,
      options.timeZone ?? null,
    ]
  );
  const cellId = randomCloudCellId();
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenant.rows[0].id, options.cell ?? "running"]
  );
  return { email, tenantId: String(tenant.rows[0].id), cellId };
}

function call(
  handler: typeof GET | typeof POST,
  body?: unknown,
  token: string | null = ADMIN_TOKEN
) {
  const request = new Request("https://substratesystems.io/api/exomem/admin/service-notices", {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
  return handler(request);
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

async function noticeRows(): Promise<number> {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM exomem_service_notices");
  return rows[0].n;
}

describe("Exomem service notices on PostgreSQL", { skip: !databaseUrl }, () => {
  before(async () => {
    process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
    schema = `service_notices_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({
      databaseUrl: scoped.toString(),
      migrationsDir: resolve(process.cwd(), "migrations"),
    });
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    delete process.env.EXOMEM_ADMIN_TOKEN;
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  describe("the operator route", () => {
    it("refuses a caller without the operator token and records nothing", async () => {
      const body = { action: "create", kind: "incident", summary: "Saving is slow." };
      assert.equal((await call(POST, body, null)).status, 401);
      assert.equal((await call(POST, body, "not-the-operator-token")).status, 401);
      assert.equal(await noticeRows(), 0);
    });

    it("schedules fleet-wide maintenance that covers every cell", async () => {
      const response = await call(POST, {
        action: "create",
        kind: "maintenance",
        summary: "We are moving storage.",
        startsAt: iso(24 * HOUR),
        endsAt: iso(25 * HOUR),
      });
      assert.equal(response.status, 200);
      const { notice } = await response.json();
      assert.equal(notice.state, "scheduled");
      assert.deepEqual(notice.cellIds, []);
      assert.equal(await noticeRows(), 1);
    });

    it("refuses a notice that names a cell that does not exist, and records nothing", async () => {
      const before = await noticeRows();
      const response = await call(POST, {
        action: "create",
        kind: "incident",
        summary: "Saving is slow.",
        cellIds: [randomCloudCellId()],
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "SERVICE_NOTICE_CELL_UNKNOWN");
      assert.equal(await noticeRows(), before);
    });

    it("keeps a cancelled or resolved notice final", async () => {
      const tenant = await seedTenant();
      const created = await call(POST, {
        action: "create",
        kind: "maintenance",
        summary: "Short stop.",
        startsAt: iso(5 * HOUR),
        endsAt: iso(6 * HOUR),
        cellIds: [tenant.cellId],
      });
      const maintenance = (await created.json()).notice;
      assert.deepEqual(maintenance.cellIds, [tenant.cellId]);

      const cancelled = await call(POST, { action: "cancel", id: maintenance.id });
      assert.equal(cancelled.status, 200);
      const cancelledAt = (await cancelled.json()).notice.cancelledAt;
      assert.ok(cancelledAt);

      // A second cancel, and a resolve of maintenance, both refuse and change nothing.
      assert.equal((await call(POST, { action: "cancel", id: maintenance.id })).status, 409);
      assert.equal((await call(POST, { action: "resolve", id: maintenance.id })).status, 400);
      const { rows } = await pool.query(
        "SELECT cancelled_at FROM exomem_service_notices WHERE id = $1",
        [maintenance.id]
      );
      assert.equal(rows[0].cancelled_at.toISOString(), cancelledAt);

      const incidentResponse = await call(POST, {
        action: "create",
        kind: "incident",
        summary: "Recall is down.",
      });
      const incident = (await incidentResponse.json()).notice;
      const resolved = await call(POST, { action: "resolve", id: incident.id });
      assert.equal(resolved.status, 200);
      const resolvedAt = (await resolved.json()).notice.resolvedAt;
      assert.equal((await call(POST, { action: "resolve", id: incident.id })).status, 409);
      assert.equal((await call(POST, { action: "cancel", id: incident.id })).status, 400);
      const after = await pool.query(
        "SELECT resolved_at FROM exomem_service_notices WHERE id = $1",
        [incident.id]
      );
      assert.equal(after.rows[0].resolved_at.toISOString(), resolvedAt);
    });

    it("refuses to cancel maintenance that has already ended", async () => {
      const ended = await pool.query(
        `INSERT INTO exomem_service_notices (kind, summary, starts_at, ends_at, announce_from)
         VALUES ('maintenance', 'Done.', now() - interval '3 hours', now() - interval '2 hours',
                 now() - interval '50 hours') RETURNING id`
      );
      const response = await call(POST, { action: "cancel", id: ended.rows[0].id });
      assert.equal(response.status, 409);
      const { rows } = await pool.query(
        "SELECT cancelled_at FROM exomem_service_notices WHERE id = $1",
        [ended.rows[0].id]
      );
      assert.equal(rows[0].cancelled_at, null);
    });

    it("lists open notices before the newest finished ones", async () => {
      const response = await call(GET);
      assert.equal(response.status, 200);
      const { notices } = await response.json();
      const states = notices.map((notice: { state: string }) => notice.state);
      const firstOver = states.indexOf("over");
      assert.ok(firstOver > 0, "open notices come first");
      assert.ok(states.slice(0, firstOver).every((state: string) => state !== "over"));
      assert.ok(states.slice(firstOver).every((state: string) => state === "over"));
    });
  });

  describe("the notice emails", () => {
    type Sent = { to: string; subject: string; textContent: string };

    /** The delivery job as it runs each minute: it queues the notice emails, then sends. */
    async function deliver(): Promise<{ sent: Sent[]; cancelled: number }> {
      const sent: Sent[] = [];
      const result = await drainExomemEmailOutbox(
        { maxMessages: 20 },
        {
          sendEmail: async (input) => {
            sent.push(input);
            return { success: true };
          },
        }
      );
      return { sent, cancelled: result.cancelled };
    }

    async function maintenanceNotice(cellIds: string[], overrides: Record<string, string> = {}) {
      const notice = await pool.query(
        `INSERT INTO exomem_service_notices (kind, summary, starts_at, ends_at, announce_from)
         VALUES ('maintenance', $1, $2, $3, now() - interval '1 hour') RETURNING id`,
        [
          overrides.summary ?? "We are moving storage.",
          overrides.startsAt ?? new Date(Date.now() + 30 * HOUR).toISOString(),
          overrides.endsAt ?? new Date(Date.now() + 31 * HOUR).toISOString(),
        ]
      );
      for (const cellId of cellIds) {
        await pool.query(
          "INSERT INTO exomem_service_notice_cells (notice_id, cell_id) VALUES ($1, $2)",
          [notice.rows[0].id, cellId]
        );
      }
      return String(notice.rows[0].id);
    }

    async function queuedFor(noticeId: string): Promise<string[]> {
      const { rows } = await pool.query(
        "SELECT recipient::text AS recipient FROM exomem_email_outbox WHERE dedupe_key LIKE $1 ORDER BY recipient",
        [`service-notice:${noticeId}:%`]
      );
      return rows.map((row) => row.recipient);
    }

    beforeEach(async () => {
      await pool.query("DELETE FROM exomem_email_outbox");
      await pool.query("DELETE FROM exomem_service_notices");
      await pool.query("DELETE FROM exomem_cloud_cells");
      await pool.query("DELETE FROM exomem_tenants");
      await pool.query("DELETE FROM exomem_users");
    });

    it("queues one email for each covered live owner and nobody else, once", async () => {
      const named = [await seedTenant(), await seedTenant()];
      const other = await seedTenant();
      const reviewer = await seedTenant({ reviewer: true });
      const gone = await seedTenant({ cell: "deleted" });
      const leaving = await seedTenant({ status: "deletion_pending" });

      const two = await maintenanceNotice(named.map((tenant) => tenant.cellId));
      const first = await fanOutServiceNoticeEmails();
      assert.deepEqual(await queuedFor(two), named.map((tenant) => tenant.email).sort());
      assert.equal(first.enqueued, 2);

      // The delivery job runs again, as it does after a crash: nothing is queued twice.
      assert.equal((await fanOutServiceNoticeEmails()).enqueued, 0);
      assert.equal((await queuedFor(two)).length, 2);

      // A fleet-wide notice covers every live owner, but not a reviewer's fixture,
      // a deleted cell or an account that is being deleted.
      const fleet = await maintenanceNotice([]);
      await fanOutServiceNoticeEmails();
      assert.deepEqual(
        await queuedFor(fleet),
        [...named, other].map((tenant) => tenant.email).sort()
      );
      for (const excluded of [reviewer, gone, leaving]) {
        assert.ok(!(await queuedFor(fleet)).includes(excluded.email));
      }
    });

    it("does not widen a notice to the fleet when the cell it names is deleted", async () => {
      const named = await seedTenant();
      await seedTenant();
      const notice = await maintenanceNotice([named.cellId]);
      await pool.query("DELETE FROM exomem_cloud_cells WHERE cell_id = $1", [named.cellId]);
      await fanOutServiceNoticeEmails();
      assert.deepEqual(await queuedFor(notice), []);
    });

    it("queues in bounded batches with the same statements each time", async () => {
      const total = SERVICE_NOTICE_FANOUT_BATCH + 50;
      await pool.query(
        `WITH users AS (
           INSERT INTO exomem_users (email)
           SELECT 'bulk-' || n || '@example.test' FROM generate_series(1, $1::int) AS n
           RETURNING id, email
         ), tenants AS (
           INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
           SELECT id, 'active', 'running' FROM users RETURNING id
         )
         INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state)
         SELECT translate(substr(md5(id::text), 1, 16), '0189', 'abcd'), id, 'running' FROM tenants`,
        [total]
      );
      const notice = await maintenanceNotice([]);

      const statements: string[] = [];
      const counting: ExomemSql = async (strings, ...values) => {
        statements.push(strings[0] ?? "");
        return taggedSql(pool)(strings, ...values);
      };
      __setExomemSqlForTests(counting);
      try {
        const passes: number[] = [];
        const perPass: number[] = [];
        for (let pass = 0; pass < 3; pass += 1) {
          const before = statements.length;
          passes.push((await fanOutServiceNoticeEmails()).enqueued);
          perPass.push(statements.length - before);
        }
        assert.deepEqual(passes, [SERVICE_NOTICE_FANOUT_BATCH, 50, 0]);
        // Finding the due notice, finding its owners, writing them: three statements, whatever the batch.
        assert.deepEqual(perPass.slice(0, 2), [3, 3]);
      } finally {
        __setExomemSqlForTests(taggedSql(pool));
      }
      assert.equal((await queuedFor(notice)).length, total);
    });

    it("sends the owner the times in their own time zone, with the operator's words and the status page", async () => {
      const owner = await seedTenant({ timeZone: "Europe/Berlin" });
      await maintenanceNotice([owner.cellId], {
        summary: "We are moving storage.",
        startsAt: "2036-01-15T02:00:00Z",
        endsAt: "2036-01-15T02:30:00Z",
      });
      const { sent } = await deliver();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, owner.email);
      assert.match(sent[0]?.textContent ?? "", /We are moving storage\./);
      assert.match(sent[0]?.textContent ?? "", /03:00/);
      assert.match(sent[0]?.textContent ?? "", /03:30/);
      assert.match(sent[0]?.textContent ?? "", /https:\/\/status\.substratesystems\.io/);
      // The same job again sends nothing more.
      assert.equal((await deliver()).sent.length, 0);
    });

    it("sends nothing for maintenance that was cancelled or has started while its email waited", async () => {
      const cancelledOwner = await seedTenant();
      const startedOwner = await seedTenant();
      const cancelled = await maintenanceNotice([cancelledOwner.cellId]);
      const started = await maintenanceNotice([startedOwner.cellId]);
      await fanOutServiceNoticeEmails();
      assert.equal((await queuedFor(cancelled)).length, 1);
      assert.equal((await queuedFor(started)).length, 1);

      await pool.query("UPDATE exomem_service_notices SET cancelled_at = now() WHERE id = $1", [
        cancelled,
      ]);
      await pool.query(
        "UPDATE exomem_service_notices SET announce_from = now() - interval '3 hours', starts_at = now() - interval '1 minute' WHERE id = $1",
        [started]
      );
      const result = await deliver();
      assert.deepEqual(result.sent, []);
      assert.equal(result.cancelled, 2);
    });

    it("tells a covered owner once that a resolved incident is over, and not while it is active", async () => {
      const owner = await seedTenant();
      await seedTenant();
      const incident = await pool.query(
        `INSERT INTO exomem_service_notices (kind, summary, starts_at)
         VALUES ('incident', 'Saving is slow.', now() - interval '2 hours') RETURNING id`
      );
      await pool.query(
        "INSERT INTO exomem_service_notice_cells (notice_id, cell_id) VALUES ($1, $2)",
        [incident.rows[0].id, owner.cellId]
      );
      assert.deepEqual((await deliver()).sent, []);

      await pool.query(
        "UPDATE exomem_service_notices SET resolved_at = now() - interval '1 hour' WHERE id = $1",
        [incident.rows[0].id]
      );
      const { sent } = await deliver();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, owner.email);
      assert.match(sent[0]?.textContent ?? "", /Saving is slow\./);
      assert.equal((await deliver()).sent.length, 0);
    });
  });

  describe("the gateway's lookup", () => {
    beforeEach(async () => {
      await pool.query("DELETE FROM exomem_service_notices");
    });

    async function insert(
      kind: "maintenance" | "incident",
      summary: string,
      times: { starts: string; ends?: string; announce?: string },
      state: { cancelled?: boolean; resolved?: boolean } = {}
    ): Promise<string> {
      const { rows } = await pool.query(
        `INSERT INTO exomem_service_notices (kind, summary, starts_at, ends_at, announce_from, cancelled_at, resolved_at)
         VALUES ($1, $2, now() + $3::interval, now() + $4::interval, now() + $5::interval,
                 CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END)
         RETURNING id`,
        [
          kind,
          summary,
          times.starts,
          times.ends ?? null,
          times.announce ?? null,
          state.cancelled ?? false,
          state.resolved ?? false,
        ]
      );
      return String(rows[0].id);
    }

    it("loads the notices a request could need and leaves out the finished, the cancelled and the far-off", async () => {
      const wanted = [
        await insert("maintenance", "announced", {
          starts: "2 hours",
          ends: "3 hours",
          announce: "-1 hour",
        }),
        await insert("maintenance", "announces in seconds", {
          starts: "2 hours",
          ends: "3 hours",
          announce: "10 seconds",
        }),
        await insert("maintenance", "under way", {
          starts: "-1 hour",
          ends: "1 hour",
          announce: "-3 hours",
        }),
        await insert("incident", "active incident", { starts: "-1 hour" }),
      ];
      await insert("maintenance", "far off", {
        starts: "5 days",
        ends: "5 days 1 hour",
        announce: "3 days",
      });
      await insert(
        "maintenance",
        "cancelled",
        { starts: "2 hours", ends: "3 hours", announce: "-1 hour" },
        { cancelled: true }
      );
      await insert("maintenance", "ended", {
        starts: "-3 hours",
        ends: "-1 hour",
        announce: "-5 hours",
      });
      await insert("incident", "resolved", { starts: "-3 hours" }, { resolved: true });

      const loaded = await loadOpenServiceNotices();
      assert.deepEqual(loaded.map((notice) => notice.id).sort(), wanted.sort());
    });

    it("turns a notice declared in the database into the header for the cells it names", async () => {
      const named = await seedTenant();
      const other = await seedTenant();
      const notice = await insert("maintenance", "Storage move.", {
        starts: "2 hours",
        ends: "3 hours",
        announce: "-1 hour",
      });
      await pool.query(
        "INSERT INTO exomem_service_notice_cells (notice_id, cell_id) VALUES ($1, $2)",
        [notice, named.cellId]
      );
      const cache = createNoticeCache({ load: loadOpenServiceNotices });
      const header = await cache.headerFor(named.cellId);
      assert.ok(header);
      const body = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
      assert.equal(body.state, "scheduled");
      assert.match(body.say, /Storage move\./);
      assert.equal(await cache.headerFor(other.cellId), null);
    });
  });
});
