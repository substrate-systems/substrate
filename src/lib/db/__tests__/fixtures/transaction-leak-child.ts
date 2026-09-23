/**
 * Child-process fixture for the "transaction() must not leak a checked-out
 * client when its callback throws synchronously" test in
 * `../pg-sql-driver.integration.test.ts` (correction round 3).
 *
 * The bug: an earlier version of `transaction()` checked a client out with
 * `await getPool().connect()` and only then evaluated the caller's callback
 * as an argument to the function that owns the try/finally. A callback that
 * throws synchronously escapes before that try/finally exists, so
 * `client.release()` is never called — the client stays checked out forever.
 * With `max: 5`, five such calls exhaust the pool, and a sixth ordinary
 * `transaction()` call waits for a slot that will never be freed.
 *
 * This runs out-of-process for the same reason `pool-error-child.ts` does:
 * a fully exhausted, permanently-leaked pool has no way to recover short of
 * the process exiting — there is no clean, in-process way to "un-leak" a
 * checked-out client, so a same-process test could only ever observe the
 * whole test run hanging, not a clean pass/fail. This script always ends
 * with an explicit `process.exit`, which — unlike `pool.end()` — does not
 * wait for checked-out clients to be released, so the parent's spawn never
 * hangs regardless of whether the bug is present.
 */

import { Client } from "pg";
import { transaction, __resetPgSqlPoolForTests } from "../../pg-sql";

// Matches pg-sql.ts's DEFAULT_POOL_MAX exactly, mirroring the reviewer's own
// reproduction.
const THROW_COUNT = 5;
const ORDINARY_CALL_BOUND_MS = 3000;
const PROBE_APPLICATION_NAME = "pg_sql_leak_probe";

/** Backends the adapter's pool opened, excluding this admin connection's own. */
async function countAdapterBackends(): Promise<number> {
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
      [PROBE_APPLICATION_NAME]
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  await __resetPgSqlPoolForTests();

  for (let index = 0; index < THROW_COUNT; index += 1) {
    let threw = false;
    try {
      await transaction(() => {
        throw new Error(`synchronous callback throw #${index}`);
      });
    } catch (err) {
      threw = err instanceof Error && err.message === `synchronous callback throw #${index}`;
    }
    if (!threw) {
      throw new Error(`throwing callback #${index} did not reject transaction() with its own error`);
    }
  }

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), ORDINARY_CALL_BOUND_MS);
  });
  const ordinary: Promise<"resolved" | "rejected"> = transaction((tx) => [tx`SELECT 1 AS ok`]).then(
    () => "resolved",
    () => "rejected"
  );
  const outcome = await Promise.race([ordinary, timeout]);
  const backends = await countAdapterBackends();

  console.log(`ORDINARY_OUTCOME=${outcome}`);
  console.log(`ADAPTER_BACKENDS=${backends}`);

  // A hard exit — not `pool.end()` — is the point: with leaked clients,
  // `pool.end()` never resolves (it waits for every checked-out client to be
  // released), so it would recreate the exact hang this test exists to
  // prove doesn't reach production. `process.exit` tears the process (and
  // every socket it holds, leaked or not) down immediately.
  process.exit(outcome === "resolved" ? 0 : 1);
}

main().catch((err) => {
  console.error("CHILD_FAILED", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
