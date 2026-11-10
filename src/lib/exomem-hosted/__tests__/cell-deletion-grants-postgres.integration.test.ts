import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { decodeJwt, jwtVerify } from "jose";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  expireCloudAwaitingCheckoutTenants,
  randomCloudCellId,
} from "../cloud-admission";
import {
  evaluateKeyWatcherHeartbeat,
  recordAlertTransition,
  runAlertBacklogMaintenance,
  runAlertNotificationPass,
  storedTransitionId,
} from "../alert-receiver";
import {
  backfillCellDeletionGrants,
  CELL_DELETION_GRACE_SECONDS,
  recordCellDeletionGrant,
} from "../cloud-deletion-grants";
import { reconcileCloudCellDesiredState } from "../cloud-lifecycle";
import { setOperationalEventSinkForTests } from "../observability";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
import {
  GET as getCellDeletions,
  POST as postCellDeletions,
} from "../../../app/api/exomem/cell-deletions/[token]/route";
import type { NextRequest } from "next/server";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// The lifecycle emails a deletion enqueues carry an encrypted payload.
process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");

// automate-cell-storage-deletion D1/D4 against real PostgreSQL: the grant a
// deletion stores, the deletion set the key watcher reads, and the backfill.
// The stop-time and write-once trigger proofs live in
// cloud-grants-postgres.integration.test.ts, which owns the real cellctl
// role -- the role's password is server-global, so two suites must not both
// set it while running in parallel.

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const DELETION_KEY_VARIABLE = "EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY";
const SCHEDULER_TOKEN = `sched-${randomBytes(16).toString("hex")}`;
const WATCHER_TOKEN = `watch-${randomBytes(16).toString("hex")}`;
const SCHEDULER_DIGEST = createHash("sha256").update(SCHEDULER_TOKEN, "utf8").digest("hex");
const WATCHER_DIGEST = createHash("sha256").update(WATCHER_TOKEN, "utf8").digest("hex");

let adminPool: Pool | undefined;
let pool: Pool | undefined;
let schema: string | undefined;
let signingEnv: Record<string, string>;
let publicKey: KeyObject;

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

async function seedTenant(input: {
  source: "complimentary" | "paddle";
  sourceState: string;
  desiredState?: "running" | "read_only" | "stopped" | "deleted";
  observedState?: string;
  sourceOccurredAt?: Date;
  cellCreatedAt?: Date;
}): Promise<{ tenantId: string; cellId: string }> {
  const user = await pool!.query(
    "INSERT INTO exomem_users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
    [`cell-deletion-${randomUUID()}@example.test`]
  );
  const tenant = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [user.rows[0]!.id]
  );
  const tenantId = tenant.rows[0]!.id as string;
  await pool!.query(
    `INSERT INTO exomem_entitlements (tenant_id, source, source_state, effective_state, source_occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      tenantId,
      input.source,
      input.sourceState,
      input.sourceState === "awaiting_checkout" || input.sourceState === "checkout_pending"
        ? "provisioning"
        : "active",
      input.sourceOccurredAt ?? new Date(),
    ]
  );
  const cellId = randomCloudCellId();
  await pool!.query(
    `INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state, observed_state, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))`,
    [
      cellId,
      tenantId,
      input.desiredState ?? "stopped",
      input.observedState ?? null,
      input.cellCreatedAt ?? null,
    ]
  );
  return { tenantId, cellId };
}

async function cellRow(cellId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool!.query(
    `SELECT cell_id, desired_state, observed_state, deletion_grant,
            deletion_stopped_at
     FROM exomem_cloud_cells WHERE cell_id = $1`,
    [cellId]
  );
  return rows[0]!;
}

function deletionsRequest(token: string): [NextRequest, { params: Promise<{ token: string }> }] {
  const request = new Request(`https://substratesystems.io/api/exomem/cell-deletions/${token}`, {
    method: "GET",
  }) as unknown as NextRequest;
  return [request, { params: Promise.resolve({ token }) }];
}

describe("Cell deletion grants PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    const pair = generateKeyPairSync("ed25519");
    publicKey = pair.publicKey;
    signingEnv = {
      [DELETION_KEY_VARIABLE]: pair.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
    process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256 = SCHEDULER_DIGEST;
    process.env.EXOMEM_KEY_WATCHER_ALERT_TOKEN_SHA256 = WATCHER_DIGEST;

    schema = `cell_deletion_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    if (schema) await adminPool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
    delete process.env.EXOMEM_HOSTED_ALERT_TOKEN_SHA256;
    delete process.env.EXOMEM_KEY_WATCHER_ALERT_TOKEN_SHA256;
    delete process.env[DELETION_KEY_VARIABLE];
  });

  beforeEach(() => {
    process.env[DELETION_KEY_VARIABLE] = signingEnv[DELETION_KEY_VARIABLE];
  });

  it("stores, in the reconcile transaction, a grant that verifies against the public key and names the cell", async () => {
    // A cancelled tenant whose export window elapsed is the reconcile's own
    // deletion path; only this test catches a grant that is wrong or absent
    // while the deletion commits.
    const { tenantId, cellId } = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      desiredState: "read_only",
      sourceOccurredAt: new Date(Date.now() - 40 * 86_400_000),
    });
    assert.equal(await reconcileCloudCellDesiredState(tenantId), "deleted");
    const row = await cellRow(cellId);
    assert.equal(typeof row.deletion_grant, "string");
    const { payload } = await jwtVerify(String(row.deletion_grant), publicKey, {
      algorithms: ["EdDSA"],
      audience: "exomem-cell-delete",
    });
    assert.equal(payload.cell_id, cellId);
    assert.equal(payload.exp, undefined, "a deletion is final: no expiry");
    assert.equal(
      (payload.purge_after as number) - (payload.iat as number),
      CELL_DELETION_GRACE_SECONDS
    );
  });

  it("stores a grant on the invite-expiry deletion path too, and commits the deletion unsigned when no key is configured", async () => {
    const { cellId } = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      cellCreatedAt: new Date(Date.now() - 8 * 86_400_000),
    });
    const outcomes = await expireCloudAwaitingCheckoutTenants();
    assert.deepEqual(
      outcomes.map((outcome) => outcome.outcome),
      ["expired"]
    );
    const row = await cellRow(cellId);
    assert.equal(row.desired_state, "deleted");
    assert.equal(typeof row.deletion_grant, "string");

    // The other product path that deletes a cell is covered; now the same
    // path with no key: only this proves the deletion still commits.
    delete process.env[DELETION_KEY_VARIABLE];
    const unsigned = await seedTenant({
      source: "paddle",
      sourceState: "awaiting_checkout",
      cellCreatedAt: new Date(Date.now() - 8 * 86_400_000),
    });
    await expireCloudAwaitingCheckoutTenants();
    const unsignedRow = await cellRow(unsigned.cellId);
    assert.equal(unsignedRow.desired_state, "deleted");
    assert.equal(unsignedRow.deletion_grant, null);
  });

  it("serves the deletion set to the key-watcher capability only, in the watcher's exact shape", async () => {
    // The watcher's reader refuses a body with any other key set, a duplicate
    // cell or a wrong type; only this catches a shape the executors cannot
    // read, and a grant-less or live cell leaking into the set.
    const withGrant = await seedTenant({
      source: "paddle",
      sourceState: "cancelled",
      desiredState: "read_only",
      sourceOccurredAt: new Date(Date.now() - 40 * 86_400_000),
    });
    await reconcileCloudCellDesiredState(withGrant.tenantId);
    await pool!.query(
      "UPDATE exomem_cloud_cells SET observed_state = 'deleted' WHERE cell_id = $1",
      [withGrant.cellId]
    );
    const withoutGrant = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      desiredState: "deleted",
    });
    const live = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      desiredState: "running",
    });

    for (const token of [SCHEDULER_TOKEN, "no-such-capability"]) {
      const [request, context] = deletionsRequest(token);
      const response = await getCellDeletions(request, context);
      assert.equal(response.status, 404, `token ${token} must learn nothing`);
      const body = await response.json();
      assert.equal(body.error.code, "ALERT_ENDPOINT_NOT_FOUND");
    }

    const [request, context] = deletionsRequest(WATCHER_TOKEN);
    const response = await getCellDeletions(request, context);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["cells", "schema_version"]);
    assert.equal(body.schema_version, 1);
    assert.ok(Array.isArray(body.cells));

    const stored = await pool!.query(
      "SELECT cell_id, deletion_grant, deletion_stopped_at FROM exomem_cloud_cells WHERE cell_id = ANY($1)",
      [[withGrant.cellId, withoutGrant.cellId, live.cellId]]
    );
    const seen = new Set<string>();
    for (const entry of body.cells) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ["cell_id", "iat", "purge_after", "stopped_at"].sort()
      );
      assert.match(entry.cell_id, /^[a-z2-7]{16}$/);
      assert.ok(!seen.has(entry.cell_id), "the watcher refuses a duplicate cell");
      seen.add(entry.cell_id);
      assert.ok(Number.isInteger(entry.iat) && Number.isInteger(entry.purge_after));
      assert.ok(entry.stopped_at === null || Number.isInteger(entry.stopped_at));
    }
    const listed = new Map<string, { iat: number; purge_after: number; stopped_at: number | null }>(
      body.cells.map((entry: { cell_id: string }) => [entry.cell_id, entry])
    );
    const grantRow = stored.rows.find((row) => row.cell_id === withGrant.cellId)!;
    const claims = decodeJwt(String(grantRow.deletion_grant));
    const served = listed.get(withGrant.cellId)!;
    // The endpoint reports the stored grant's own claims, so a mismatch here
    // means the watcher and the executors disagree about the purge moment.
    assert.equal(served.iat, claims.iat);
    assert.equal(served.purge_after, claims.purge_after);
    assert.equal(
      served.stopped_at,
      Math.floor(new Date(grantRow.deletion_stopped_at).getTime() / 1000)
    );
    assert.equal(listed.has(withoutGrant.cellId), false, "a grant-less deletion is not served");
    assert.equal(listed.has(live.cellId), false, "a live cell is never served");
  });

  it("answers 500 with a failed event on a stored grant that does not decode, never a partial set", async () => {
    // A grant-less deleted row must never reach the watcher, so the filter
    // alone cannot serve this test: only a stored-but-undecodable grant
    // proves the route refuses the whole set rather than skipping a row.
    const { cellId } = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      desiredState: "deleted",
    });
    await pool!.query("UPDATE exomem_cloud_cells SET deletion_grant = 'not-a-jwt' WHERE cell_id = $1", [
      cellId,
    ]);
    const lines: string[] = [];
    setOperationalEventSinkForTests((line) => lines.push(line));
    try {
      const [request, context] = deletionsRequest(WATCHER_TOKEN);
      const response = await getCellDeletions(request, context);
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.cells, undefined, "a failed read names no cell");
    } finally {
      setOperationalEventSinkForTests(null);
      await pool!.query("DELETE FROM exomem_cloud_cells WHERE cell_id = $1", [cellId]);
    }
    const events = lines.map((line) => JSON.parse(line) as { event: string; outcome: string });
    assert.equal(events.some((event) => event.event === "exomem.cell-deletions.failed"), true);
    assert.equal(events.some((event) => event.event === "exomem.cell-deletions.denied"), false);
  });

  it("answers other methods with the same 404 as the alerts route", async () => {
    const response = await postCellDeletions();
    assert.equal(response.status, 404);
  });

  it("backfills only deleted cells without a grant: dry run writes nothing, commit signs, an existing grant stays", async () => {
    // The one job that writes deleted cells in bulk; only this catches a backfill
    // that overwrites a live grant or signs outside the deleted set.
    const missing = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      desiredState: "deleted",
    });
    const granted = await seedTenant({
      source: "complimentary",
      sourceState: "complimentary_active",
      desiredState: "deleted",
    });
    await interactiveTransaction(async (tx) => {
      await recordCellDeletionGrant(tx, granted.cellId, { env: signingEnv });
    });
    const existingGrant = (await cellRow(granted.cellId)).deletion_grant;
    assert.equal(typeof existingGrant, "string");

    const dry = await backfillCellDeletionGrants({ commit: false, env: signingEnv });
    assert.equal(dry.missing >= 1, true);
    assert.equal(dry.signed, 0, "a dry run signs nothing");
    assert.equal((await cellRow(missing.cellId)).deletion_grant, null, "a dry run writes nothing");

    const done = await backfillCellDeletionGrants({ commit: true, env: signingEnv });
    assert.equal(done.signed >= 1, true);
    const row = await cellRow(missing.cellId);
    assert.equal(typeof row.deletion_grant, "string");
    const { payload } = await jwtVerify(String(row.deletion_grant), publicKey, {
      algorithms: ["EdDSA"],
      audience: "exomem-cell-delete",
    });
    assert.equal(payload.cell_id, missing.cellId);
    assert.equal(
      (await cellRow(granted.cellId)).deletion_grant,
      existingGrant,
      "an existing grant is never replaced"
    );

    // Without the key the run refuses, so a commit pass can never report a
    // backfill done while signing nothing.
    await assert.rejects(backfillCellDeletionGrants({ commit: true, env: {} }));
  });

  it("keeps a firing key-watcher alert active until its own resolution arrives", async () => {
    // CELL_DELETION_ANOMALY fires while a deletion stalls; only this catches a
    // receiver change that resolves alerts on a schedule or on another job's
    // activity rather than on the watcher's own resolved transition. The
    // heartbeat and the backlog pass run here precisely to try to disturb it.
    const alert = `CELL_DELETION_ANOMALY:${randomCloudCellId()}`;
    await recordAlertTransition({
      transitionId: storedTransitionId("b2-key-watcher", randomUUID()),
      job: "b2-key-watcher",
      alert,
      active: true,
    });
    await runAlertNotificationPass({ limit: 5 });
    await runAlertBacklogMaintenance();
    await evaluateKeyWatcherHeartbeat(new Date());
    await evaluateKeyWatcherHeartbeat(new Date(Date.now() + 3 * 3_600_000));

    const { rows } = await pool!.query(
      `SELECT active FROM exomem_hosted_alert_transitions
       WHERE job = 'b2-key-watcher' AND alert = $1
       ORDER BY received_at DESC`,
      [alert]
    );
    assert.equal(rows.length, 1, "no transition the watcher never sent may appear");
    assert.equal(rows[0]!.active, true, "the firing state stays until the watcher resolves it");
  });
});
