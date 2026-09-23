import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import { sendCloudCancellationNoticeOnce } from "../cloud-cancellation-notice";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Item 5 / task 3.7: the cancellation notice's claim-then-send is idempotent
// under redelivery -- exactly one send per Cloud tenant -- against real
// PostgreSQL's own column-level dedupe (migration 0057).

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

async function resetFleet(): Promise<void> {
  await pool!.query("DELETE FROM exomem_entitlements");
  await pool!.query("DELETE FROM exomem_cloud_cells");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM users");
}

async function seedTenant(input: {
  desiredState?: "running" | "read_only" | "stopped" | "deleted";
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
  });

  after(async () => {
    __setExomemSqlForTests(null);
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

  const SOURCE_OCCURRED_AT = new Date("2026-08-01T00:00:00.000Z");

  it("sends exactly once under redelivery: the same tenant, called twice, sends only the first time", async () => {
    const { tenantId, email } = await seedTenant();
    const sent: Array<{ to: string; subject: string }> = [];
    const dependencies = {
      sendEmail: async (input: { to: string; subject: string }) => {
        sent.push(input);
        return { success: true };
      },
    };

    const first = await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, dependencies);
    const second = await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, dependencies);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, email);
    assert.match(sent[0]!.subject, /cancelled/i);
  });

  // Security review finding 9c: the deletion date in the email is computed
  // from the entitlement's own cancellation timestamp (sourceOccurredAt),
  // not from whenever the send happens to run -- matching
  // desiredCloudCellState's own 30-day export-window arithmetic exactly.
  it("computes the deletion date from sourceOccurredAt, not from send time", async () => {
    const { tenantId } = await seedTenant();
    let htmlContent = "";
    await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, {
      sendEmail: async (input) => {
        htmlContent = input.htmlContent;
        return { success: true };
      },
    });
    // 2026-08-01 + 30 days = 2026-08-31.
    assert.match(htmlContent, /Aug(?:ust)? 31,? 2026|2026-08-31|31 Aug(?:ust)? 2026/);
  });

  // Security review finding 9a: a failed send must not leave the claim
  // permanently set -- nothing would ever be retried, and the tenant loses
  // its one notice forever.
  it("un-claims when the send fails, so a later call can try again", async () => {
    const { tenantId, cellId } = await seedTenant();
    let attempts = 0;
    const first = await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, {
      sendEmail: async () => {
        attempts += 1;
        return { success: false };
      },
    });
    assert.equal(first, false);
    const { rows: afterFailure } = await pool!.query(
      "SELECT cancellation_notice_sent_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [cellId]
    );
    assert.equal(afterFailure[0]!.cancellation_notice_sent_at, null);

    const second = await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, {
      sendEmail: async () => {
        attempts += 1;
        return { success: true };
      },
    });
    assert.equal(second, true);
    assert.equal(attempts, 2);
    const { rows: afterSuccess } = await pool!.query(
      "SELECT cancellation_notice_sent_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [cellId]
    );
    assert.ok(afterSuccess[0]!.cancellation_notice_sent_at);
  });

  it("marks the claim column so it survives across separate calls, not just in-process state", async () => {
    const { tenantId, cellId } = await seedTenant();
    await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, {
      sendEmail: async () => ({ success: true }),
    });
    const { rows } = await pool!.query(
      "SELECT cancellation_notice_sent_at FROM exomem_cloud_cells WHERE cell_id = $1",
      [cellId]
    );
    assert.ok(rows[0]!.cancellation_notice_sent_at);
  });

  it("sends nothing for a tenant with no live Cloud cell", async () => {
    let sendCalls = 0;
    const result = await sendCloudCancellationNoticeOnce(randomUUID(), SOURCE_OCCURRED_AT, {
      sendEmail: async () => {
        sendCalls += 1;
        return { success: true };
      },
    });
    assert.equal(result, false);
    assert.equal(sendCalls, 0);
  });

  it("sends nothing for a tenant whose only Cloud cell is already deleted", async () => {
    const { tenantId } = await seedTenant({ desiredState: "deleted" });
    let sendCalls = 0;
    const result = await sendCloudCancellationNoticeOnce(tenantId, SOURCE_OCCURRED_AT, {
      sendEmail: async () => {
        sendCalls += 1;
        return { success: true };
      },
    });
    assert.equal(result, false);
    assert.equal(sendCalls, 0);
  });
});
