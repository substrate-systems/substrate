import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { NextRequest } from "next/server";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { GET, POST } from "../../../app/api/exomem/admin/service-notices/route";
import { randomCloudCellId } from "../cloud-admission";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
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

/** One live tenant: an owner with an email address and a running cell. */
async function seedTenant(): Promise<{ email: string; tenantId: string; cellId: string }> {
  const email = `notice-${randomUUID()}@example.test`;
  const user = await pool.query("INSERT INTO exomem_users (email) VALUES ($1) RETURNING id", [
    email,
  ]);
  const tenant = await pool.query(
    "INSERT INTO exomem_tenants (owner_user_id, status, desired_state) VALUES ($1, 'active', 'running') RETURNING id",
    [user.rows[0].id]
  );
  const cellId = randomCloudCellId();
  await pool.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, 'running')",
    [cellId, tenant.rows[0].id]
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
});
