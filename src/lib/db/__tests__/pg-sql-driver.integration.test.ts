/**
 * Red-first coverage for the standard-Postgres driver swap (design D6,
 * change `adopt-exomem-cloud-plain-cells`, Substrate tasks 2.1-2.3).
 *
 * This exercises the shared `pg`-backed adapter directly, and the *default*,
 * uninjected code path of each of the four modules that used to build their
 * own `@neondatabase/serverless` `neon()` client. It deliberately does NOT
 * use the `__setExomemSqlForTests` / `__setHostedBackupSqlForTests` seams —
 * those bypass the very client construction under test. Instead it points
 * `DATABASE_URL` at a standard PostgreSQL server and calls the exported
 * functions un-injected, so each module's own lazy client construction runs
 * for real.
 *
 * Before the driver swap, `neon()` cannot reach a standard PostgreSQL server
 * (it speaks an HTTPS-only protocol to a Neon endpoint), so the module
 * assertions below fail. After the swap to the shared `pg`-backed adapter,
 * they pass, while behaviour (including the `.transaction()` call shape used
 * by `recoverFinalizeAtomic`) stays identical.
 *
 * Skipped when `EXOMEM_TEST_DATABASE_URL` is unset, matching every other
 * `*.integration.test.ts` suite in this repo.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DatabaseError, Pool } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { EXOMEM_PADDLE_PRODUCT_KEY } from "../../exomem-hosted/paddle-config";
import { ensureExomemPostgresTestExtensions } from "../../exomem-hosted/__tests__/postgres-test-extensions";
import {
  __resetPgSqlPoolForTests,
  __transactionWithClientForTests,
  query,
  sql,
  transaction,
  type TransactionClient,
} from "../pg-sql";

const DATABASE_URL = process.env.EXOMEM_TEST_DATABASE_URL;

const POOL_ERROR_CHILD_FIXTURE = fileURLToPath(new URL("./fixtures/pool-error-child.ts", import.meta.url));
const TRANSACTION_LEAK_CHILD_FIXTURE = fileURLToPath(
  new URL("./fixtures/transaction-leak-child.ts", import.meta.url)
);

// A hard ceiling on top of each fixture's own internal bound, so a fixture
// that hangs before reaching its own timeout logic (rather than because of
// the bug it is probing) still cannot hang this test file.
const CHILD_FIXTURE_KILL_TIMEOUT_MS = 15_000;

function runChildFixture(
  fixturePath: string,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string; killedByTimeout: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixturePath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    const killTimer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, CHILD_FIXTURE_KILL_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, killedByTimeout });
    });
  });
}

function base64UrlToken(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("standard PostgreSQL driver (design D6)", { skip: !DATABASE_URL }, () => {
  let pool: Pool;
  let scopedUrl: string;
  let schema: string;
  let originalDatabaseUrl: string | undefined;

  before(async () => {
    originalDatabaseUrl = process.env.DATABASE_URL;
    schema = `d6_pg_sql_driver_${randomUUID().replaceAll("-", "")}`;

    await ensureExomemPostgresTestExtensions(DATABASE_URL!);
    const admin = new Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    const scoped = new URL(DATABASE_URL!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    scopedUrl = scoped.toString();
    await applyMigrations({ databaseUrl: scopedUrl });

    pool = new Pool({ connectionString: scopedUrl });

    // This is the thing under test: point every module's default, uninjected
    // client construction at the scoped schema, not a seam wrapped around it.
    process.env.DATABASE_URL = scopedUrl;
    await __resetPgSqlPoolForTests();
  });

  after(async () => {
    await __resetPgSqlPoolForTests();
    process.env.DATABASE_URL = originalDatabaseUrl;
    await pool?.end();
    const admin = new Pool({ connectionString: DATABASE_URL });
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("the shared adapter's tagged template returns the fullResults shape", async () => {
    const result = await sql`SELECT 1::int AS one`;
    assert.deepEqual(result.rows, [{ one: 1 }]);
    assert.equal(result.rowCount, 1);
  });

  it("the shared adapter's query(text, params) form matches the tagged-template shape", async () => {
    const result = await query("SELECT $1::int AS value", [42]);
    assert.deepEqual(result.rows, [{ value: 42 }]);
    assert.equal(result.rowCount, 1);
  });

  it("the shared adapter's transaction() commits every statement together", async () => {
    await pool.query("CREATE TABLE IF NOT EXISTS pg_sql_driver_probe (id int PRIMARY KEY)");
    await transaction((tx) => [
      tx`INSERT INTO pg_sql_driver_probe (id) VALUES (1)`,
      tx`INSERT INTO pg_sql_driver_probe (id) VALUES (2)`,
    ]);
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM pg_sql_driver_probe ORDER BY id");
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  });

  it("the shared adapter's transaction() rolls back every statement on failure", async () => {
    await pool.query("TRUNCATE pg_sql_driver_probe");
    await assert.rejects(
      transaction((tx) => [
        tx`INSERT INTO pg_sql_driver_probe (id) VALUES (10)`,
        tx`INSERT INTO pg_sql_driver_probe (id) VALUES (10)`, // duplicate PK -> 23505
      ])
    );
    const { rows } = await pool.query("SELECT id FROM pg_sql_driver_probe");
    assert.deepEqual(rows, [], "the first insert must not survive the second statement's failure");
  });

  it("exomem-hosted/db.ts's default sql() reaches standard Postgres", async () => {
    const { inspectValidInvite } = await import("../../exomem-hosted/db");
    const result = await inspectValidInvite(randomBytes(32));
    assert.equal(result, null);
  });

  it("exomem-hosted/paddle-event-store.ts's default store reaches standard Postgres", async () => {
    const { getDefaultSqlExomemPaddleEventStore } = await import(
      "../../exomem-hosted/paddle-event-store"
    );
    const store = getDefaultSqlExomemPaddleEventStore();
    const result = await store.applyVerifiedEventAndMarkProcessedAtomically({
      eventId: `probe-${randomUUID()}`,
      eventType: "subscription.created",
      environment: "sandbox",
      origin: "webhook",
      revision: { occurredAt: new Date().toISOString(), eventId: randomUUID() },
      correlation: {
        productKey: EXOMEM_PADDLE_PRODUCT_KEY,
        userId: randomUUID(),
        tenantId: randomUUID(),
      },
      sourceState: "active",
      capabilities: [],
      resourceLimits: { storageBytes: 0, uploadBytes: 0, workerCount: 0 },
      providerReferences: {
        customerId: null,
        subscriptionId: null,
        transactionId: null,
        productId: null,
        priceId: null,
      },
    });
    // No matching tenant/entitlement exists in this scoped schema, so the
    // decision CTE correctly reports "ignored" — this proves the round trip
    // to standard Postgres, not the business outcome.
    assert.equal(result.outcome, "ignored");
  });

  it("hosted-backup/db.ts's default sql() reaches standard Postgres", async () => {
    const { findUserByEmail } = await import("../../hosted-backup/db");
    const result = await findUserByEmail(`nobody-${randomUUID()}@example.test`);
    assert.equal(result, null);
  });

  it("hosted-backup/db.ts's recoverFinalizeAtomic() transaction reaches standard Postgres", async () => {
    const { insertUser, insertAuthCredentials, recoverFinalizeAtomic } = await import(
      "../../hosted-backup/db"
    );
    const user = await insertUser(`recovery-${randomUUID()}@example.test`);
    await insertAuthCredentials({
      userId: user.id,
      serverPasswordHash: "original-hash",
      clientSalt: new Uint8Array(16).fill(1),
      kdfParams: { algorithm: "argon2id", memory: 65536, iterations: 3, parallelism: 4 },
      wrappedDek: new Uint8Array(16).fill(2),
      recoveryKeyVerifier: "verifier",
      recoveryKeyWrappedDek: new Uint8Array(16).fill(3),
    });

    const jti = randomUUID();
    const first = await recoverFinalizeAtomic({
      jti,
      userId: user.id,
      serverPasswordHash: "new-hash",
      clientSalt: new Uint8Array(16).fill(4),
      kdfParams: { algorithm: "argon2id", memory: 65536, iterations: 3, parallelism: 4 },
      wrappedDek: new Uint8Array(16).fill(5),
    });
    assert.deepEqual(first, { tokenAlreadyUsed: false });

    const { rows } = await pool.query<{ server_password_hash: string }>(
      "SELECT server_password_hash FROM auth_credentials WHERE user_id = $1",
      [user.id]
    );
    assert.equal(rows[0]?.server_password_hash, "new-hash");

    // Replaying the same jti must hit the recovery_tokens_used primary key
    // and be reported as already-used, not thrown as a bare unhandled error —
    // this is the part of the driver swap most at risk of behaving
    // differently: Neon's `.transaction()` batches queries over one HTTP
    // round trip, the pg-backed replacement runs them sequentially inside an
    // explicit BEGIN/COMMIT on one connection.
    const second = await recoverFinalizeAtomic({
      jti,
      userId: user.id,
      serverPasswordHash: "another-hash",
      clientSalt: new Uint8Array(16).fill(6),
      kdfParams: { algorithm: "argon2id", memory: 65536, iterations: 3, parallelism: 4 },
      wrappedDek: new Uint8Array(16).fill(7),
    });
    assert.deepEqual(second, { tokenAlreadyUsed: true });
  });

  it("hosted-backup/claim-tokens.ts's default sql() reaches standard Postgres", async () => {
    const { verifyClaimToken } = await import("../../hosted-backup/claim-tokens");
    const bogusToken = base64UrlToken(randomBytes(32));
    const result = await verifyClaimToken(bogusToken);
    assert.equal(result.kind, "invalid");
  });

  it("a pooled backend terminated by the server does not crash the process, and the next query still works", async () => {
    const { code, stdout, stderr } = await runChildFixture(POOL_ERROR_CHILD_FIXTURE, {
      ...process.env,
      DATABASE_URL: scopedUrl,
    });
    assert.equal(
      code,
      0,
      `child should exit 0 (survive the terminated backend); got code=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.match(stdout, /SURVIVED_AND_QUERY_OK/);
    // Content-free: the pool's error log must never carry the connection
    // string (host, user, password) or a query.
    assert.doesNotMatch(stderr + stdout, /DATABASE_URL|postgresql:\/\//);
  });

  it("transaction() does not leak a checked-out client when the callback throws synchronously, and a later call does not hang", async () => {
    const probeUrl = new URL(scopedUrl);
    probeUrl.searchParams.set("application_name", "pg_sql_leak_probe");
    const { code, stdout, stderr, killedByTimeout } = await runChildFixture(TRANSACTION_LEAK_CHILD_FIXTURE, {
      ...process.env,
      DATABASE_URL: probeUrl.toString(),
    });
    assert.equal(
      killedByTimeout,
      false,
      `child had to be force-killed after ${CHILD_FIXTURE_KILL_TIMEOUT_MS}ms — this is the hang itself\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.equal(
      code,
      0,
      `child should exit 0 (the sixth, ordinary transaction() must resolve, not hang); got code=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
    assert.match(stdout, /ORDINARY_OUTCOME=resolved/);
    const backendsMatch = stdout.match(/ADAPTER_BACKENDS=(\d+)/);
    assert.ok(backendsMatch, `expected an ADAPTER_BACKENDS line in stdout:\n${stdout}`);
    assert.ok(
      Number(backendsMatch[1]) <= 1,
      `expected at most 1 backend left open by the adapter (the successful sixth transaction's pooled ` +
        `connection) — five leaked, never-released clients would show as 5; got ${backendsMatch[1]}`
    );
  });
});

/**
 * Pure unit coverage for `transaction()`'s rollback/discard logic, against an
 * injected fake client — no real Postgres needed, so this runs unconditionally
 * (including in the main `npm test`, not gated on `EXOMEM_TEST_DATABASE_URL`).
 */
describe("pg-sql transaction() error handling (unit)", () => {
  function fakeClient(
    onQuery: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
  ): TransactionClient & { releasedWith: unknown[] } {
    const releasedWith: unknown[] = [];
    return {
      query: onQuery,
      release: (err?: Error | boolean) => releasedWith.push(err),
      releasedWith,
    };
  }

  it("surfaces the original DatabaseError, not a ROLLBACK failure that masks it, and discards the client", async () => {
    const dbError = new DatabaseError("duplicate key value violates unique constraint", 0, "error");
    (dbError as DatabaseError & { code?: string }).code = "23505";
    const rollbackFailure = new Error("Connection terminated unexpectedly");

    const calls: string[] = [];
    const client = fakeClient(async (text) => {
      calls.push(text);
      if (text === "BEGIN") return { rows: [], rowCount: 0 };
      if (text === "ROLLBACK") throw rollbackFailure;
      throw dbError;
    });

    await assert.rejects(
      __transactionWithClientForTests(client, (tx) => [tx`INSERT INTO probe (id) VALUES (${1})`]),
      (err: unknown) => err === dbError
    );
    assert.deepEqual(calls, ["BEGIN", "INSERT INTO probe (id) VALUES ($1)", "ROLLBACK"]);
    assert.deepEqual(
      client.releasedWith,
      [true],
      "a failed ROLLBACK must discard the client even though the original failure was an ordinary DatabaseError"
    );
  });

  it("releases a healthy client normally (no discard) after an ordinary DatabaseError and a successful ROLLBACK", async () => {
    const dbError = new DatabaseError("duplicate key value violates unique constraint", 0, "error");
    (dbError as DatabaseError & { code?: string }).code = "23505";

    const client = fakeClient(async (text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      throw dbError;
    });

    await assert.rejects(
      __transactionWithClientForTests(client, (tx) => [tx`INSERT INTO probe (id) VALUES (${1})`]),
      (err: unknown) => err === dbError
    );
    assert.deepEqual(
      client.releasedWith,
      [false],
      "an ordinary DatabaseError with a successful ROLLBACK leaves the connection reusable"
    );
  });

  it("discards the client on a connection-level failure even when ROLLBACK itself succeeds", async () => {
    const socketError = Object.assign(new Error("Connection terminated unexpectedly"), {});

    const client = fakeClient(async (text) => {
      if (text === "BEGIN" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      throw socketError;
    });

    await assert.rejects(
      __transactionWithClientForTests(client, (tx) => [tx`INSERT INTO probe (id) VALUES (${1})`]),
      (err: unknown) => err === socketError
    );
    assert.deepEqual(client.releasedWith, [true]);
  });
});
