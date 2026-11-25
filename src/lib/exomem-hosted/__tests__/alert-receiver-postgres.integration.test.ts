import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { isRedundantTransition, markAlertNotified, recordAlertTransition } from "../alert-receiver";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The alert receiver's repeat rule runs its time comparison in SQL against
// the database clock; the unit tests stand in for the table with a fake, so
// only real PostgreSQL proves the comparison and the suppressed flag.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

const JOB = "cloud-deploy";

function taggedSql(client: Pool): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

/** A transition id nothing else in this suite uses; each test also has its own alert name. */
function newTransitionId(): string {
  return randomUUID().replaceAll("-", "").repeat(2);
}

/** An emailed (not suppressed) row that the database stamped `hoursAgo` hours ago. */
async function seedEmailed(alert: string, active: boolean, hoursAgo: number): Promise<void> {
  await pool!.query(
    `INSERT INTO exomem_hosted_alert_transitions
       (transition_id, job, alert, active, received_at, notification_state, notified_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5), 'delivered', now())`,
    [newTransitionId(), JOB, alert, active, hoursAgo]
  );
}

function incoming(alert: string, active: boolean) {
  return { transitionId: newTransitionId(), job: JOB, alert, active };
}

describe("Alert receiver repeat rule PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `alert_receiver_it_${randomUUID().replaceAll("-", "")}`;
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

  it("repeats a still-active alert once the last email is more than 23 hours old", async () => {
    await seedEmailed("repeat-window-recent", true, 22);
    await seedEmailed("repeat-window-old", true, 24);
    assert.equal(await isRedundantTransition(incoming("repeat-window-recent", true)), true);
    assert.equal(await isRedundantTransition(incoming("repeat-window-old", true)), false);
  });

  it("keeps an inactive repeat redundant however old the last email is", async () => {
    await seedEmailed("inactive-repeat", false, 72);
    assert.equal(await isRedundantTransition(incoming("inactive-repeat", false)), true);
  });

  it("notifies a change of state whatever the age of the last email", async () => {
    await seedEmailed("state-change", false, 1);
    assert.equal(await isRedundantTransition(incoming("state-change", true)), false);
  });

  it("counts the 23 hours from the last email, not from a suppressed report", async () => {
    const alert = "suppressed-reports";
    await seedEmailed(alert, true, 24);
    // A sender reports an hour ago; the receiver suppresses it as a repeat.
    const report = incoming(alert, true);
    await recordAlertTransition(report);
    await markAlertNotified(report.transitionId, { suppressed: true });
    await pool!.query(
      "UPDATE exomem_hosted_alert_transitions SET received_at = now() - interval '1 hour' WHERE transition_id = $1",
      [report.transitionId]
    );

    const stored = await pool!.query(
      "SELECT notification_state, suppressed FROM exomem_hosted_alert_transitions WHERE transition_id = $1",
      [report.transitionId]
    );
    assert.deepEqual(stored.rows[0], { notification_state: "delivered", suppressed: true });
    assert.equal(await isRedundantTransition(incoming(alert, true)), false);
  });
});
