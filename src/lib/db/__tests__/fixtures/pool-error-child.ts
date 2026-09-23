/**
 * Child-process fixture for the "pool error must not crash the process" test
 * in `../pg-sql-driver.integration.test.ts`.
 *
 * Runs a query through the shared adapter (establishing a pooled connection),
 * has a separate admin connection terminate that exact backend from the
 * server side while it sits idle back in the pool — mirroring
 * `pg_terminate_backend`, a PgBouncer restart, or a network drop — then runs
 * a second query through the adapter.
 *
 * This has to run out-of-process: the bug under test is an *uncaught
 * exception that kills the process*. A same-process assertion can only ever
 * observe that crash as the whole test run aborting, not as a clean pass/fail
 * — the parent test spawns this file and asserts on its exit code and
 * stdout instead.
 *
 * Exit 0 and prints SURVIVED_AND_QUERY_OK only if the process stayed alive
 * and the follow-up query succeeded. Any other outcome (including this
 * script's own unexpected errors) exits non-zero, which is exactly what an
 * unhandled pool "error" event does today when nothing listens for it.
 */

import { Client } from "pg";
import { sql, __resetPgSqlPoolForTests } from "../../pg-sql";

async function main(): Promise<void> {
  await __resetPgSqlPoolForTests();

  const first = await sql`SELECT pg_backend_pid() AS pid`;
  const pid = Number((first.rows[0] as { pid: number | string }).pid);
  if (!Number.isInteger(pid)) throw new Error("could not read the adapter's backend pid");

  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }

  // Give the server-initiated socket close time to reach the pool before the
  // next query reuses (or replaces) that connection.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const second = await sql`SELECT 1::int AS ok`;
  if (second.rows[0]?.ok !== 1) {
    throw new Error("the follow-up query did not return the expected row");
  }

  console.log("SURVIVED_AND_QUERY_OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("CHILD_FAILED", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
