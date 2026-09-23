/**
 * Shared PostgreSQL driver adapter (design D6, `adopt-exomem-cloud-plain-cells`).
 *
 * Replaces the per-module `@neondatabase/serverless` `neon()` clients with a
 * single `pg`-backed module exposing the same call shape every caller used:
 * a tagged-template `sql` function whose result is the `{ rows, rowCount }`
 * shape Neon returned under `fullResults: true`, a plain `query(text, values)`
 * function with the same result shape, and a `transaction(callback)` helper
 * matching Neon's `sql.transaction((tx) => [...])` batch-atomic call shape.
 *
 * Backed by one lazily created `pg.Pool` per process against `DATABASE_URL`.
 * The pool is sized small: callers here issue one-off, non-transactional
 * queries from serverless instances that sit behind a transaction-mode
 * pooler, so holding many idle connections open would be wasted capacity on
 * the pooler side. TLS follows the connection string itself — this module
 * never sets `ssl` directly. Note: pg 8's bundled `pg-connection-string`
 * currently aliases `sslmode=require` to verify-full, but v3 (and pg 9) will
 * revert `require` to encrypt-only, so production strings for our own server
 * use `sslmode=verify-full` explicitly rather than relying on that alias.
 * Every query is issued unnamed (no `name` on the query config), so no
 * prepared statement outlives the connection it ran on, let alone a
 * transaction. Checking a client out of an exhausted pool waits at most
 * `connectionTimeoutMillis` (10s) before failing with an error, rather than
 * hanging a serverless request indefinitely.
 */

import { DatabaseError, Pool } from "pg";

export type PgSqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

export type PgSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<PgSqlResult>;

/** A query captured lazily inside a `transaction()` callback; not sent until the transaction runs it. */
export type PgLazyQuery = { text: string; values: unknown[] };

export type PgTransactionTag = (strings: TemplateStringsArray, ...values: unknown[]) => PgLazyQuery;

let pool: Pool | null = null;

// Small and serverless-friendly: this pool is for one-off queries behind a
// transaction-mode pooler (PgBouncer), not for holding many connections open.
// Interactive-transaction pools elsewhere (e.g. exomem-hosted/db.ts) size
// themselves separately for their own connection-holding needs.
const DEFAULT_POOL_MAX = 5;

// A checkout against an exhausted pool fails with an error after this many
// milliseconds instead of waiting forever — belt-and-suspenders alongside
// `transaction()` never leaking a client in the first place: a pool that is
// genuinely full (real concurrent load, not a leak) should still fail a
// serverless request fast rather than hang it.
const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 10_000;

/** Logs an error's code/class only — never a message, the DSN or a query. */
function logContentFree(context: string, err: unknown): void {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`[pg-sql] ${context}`, { code, name });
}

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const created = new Pool({
    connectionString: url,
    max: DEFAULT_POOL_MAX,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MILLIS,
  });
  // A pooled client can be terminated by the server while sitting idle in the
  // pool — `pg_terminate_backend`, a PgBouncer restart, a network drop. `pg`
  // surfaces that as an "error" event on the Pool itself, not as a rejection
  // of any in-flight query. With no listener, that is an uncaught exception
  // that kills the process (Node's default for an unhandled EventEmitter
  // "error"). The pool already discards the broken client on its own; this
  // listener only has to exist so the event doesn't crash the process.
  created.on("error", (err) => logContentFree("pool error", err));
  pool = created;
  return pool;
}

function buildText(strings: TemplateStringsArray, values: unknown[]): string {
  let text = strings[0];
  for (let index = 0; index < values.length; index += 1) {
    text += `$${index + 1}${strings[index + 1]}`;
  }
  return text;
}

/** The minimal `query` shape every caller of `runQuery` needs — real `Pool`/`PoolClient`s satisfy it structurally, and so does a test double. */
type QueryableClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

async function runQuery(
  client: QueryableClient,
  text: string,
  values: unknown[]
): Promise<PgSqlResult> {
  const result = await client.query(text, values);
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
}

/** Tagged-template entry point, matching the Neon `fullResults: true` shape. */
export const sql: PgSql = async (strings, ...values) => runQuery(getPool(), buildText(strings, values), values);

/** Plain `query(text, params)` entry point, same result shape as `sql`. */
export async function query(text: string, values: unknown[] = []): Promise<PgSqlResult> {
  return runQuery(getPool(), text, values);
}

/**
 * A `DatabaseError` is the backend reporting a normal SQL-level failure (a
 * unique violation, a check constraint, a syntax error, ...) over an
 * otherwise-healthy connection — safe to reuse after `ROLLBACK`. Anything
 * else (a socket error, "Connection terminated unexpectedly", the ROLLBACK
 * itself failing) means the connection is no longer trustworthy.
 */
function isConnectionLevelError(err: unknown): boolean {
  return !(err instanceof DatabaseError);
}

/** The minimal client shape `runQueriesOnClient` needs — real `PoolClient`s satisfy it, and so does a test double. */
export type TransactionClient = QueryableClient & {
  release: (err?: Error | boolean) => void;
};

/**
 * Runs `queries` in order on `client` inside `BEGIN`/`COMMIT`, rolling back
 * and always re-throwing the *original* failure on error — a failed
 * `ROLLBACK` must never mask it, since callers branch on the original
 * error's `.code` (e.g. `recoverFinalizeAtomic`'s `.code === "23505"`).
 * Releases the client with `discard = true` (so the pool destroys it rather
 * than reusing it) whenever the failure was connection-level rather than an
 * ordinary `DatabaseError`, or the `ROLLBACK` itself failed.
 */
async function runQueriesOnClient(
  client: TransactionClient,
  queries: PgLazyQuery[]
): Promise<PgSqlResult[]> {
  let discard = false;
  try {
    await client.query("BEGIN");
    const results: PgSqlResult[] = [];
    for (const lazyQuery of queries) {
      results.push(await runQuery(client, lazyQuery.text, lazyQuery.values));
    }
    await client.query("COMMIT");
    return results;
  } catch (error) {
    discard = isConnectionLevelError(error);
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The ROLLBACK itself failed — almost always because the connection
      // died mid-transaction. Log it content-free and keep going: the
      // original `error` is what the caller needs, and a failed ROLLBACK
      // must never mask it.
      discard = true;
      logContentFree("rollback failed", rollbackError);
    }
    throw error;
  } finally {
    // Passing `true` tells the pool to destroy this client instead of
    // returning it to the pool for reuse.
    client.release(discard);
  }
}

/**
 * Runs an ordered batch of queries in one transaction, matching the call
 * shape of Neon's `sql.transaction((tx) => [...])`: the callback receives a
 * lazy tagged-template `tx` and returns the array of queries to run, in
 * order, on one connection — all committing together or all rolling back.
 *
 * Unlike Neon's HTTP pipeline, the queries are sent to the server one at a
 * time rather than batched in a single round trip; the atomicity and
 * ordering guarantees callers rely on (and the error, e.g. a unique
 * violation's `.code`, that a failing statement throws) are unchanged.
 */
export async function transaction(
  callback: (tx: PgTransactionTag) => PgLazyQuery[]
): Promise<PgSqlResult[]> {
  const lazyTag: PgTransactionTag = (strings, ...values) => ({
    text: buildText(strings, values),
    values,
  });
  // Build the queries — running the caller's callback — *before* checking a
  // client out of the pool. A callback that throws synchronously must never
  // have taken a client, or that client is checked out forever: nothing
  // downstream would ever call `.release()` on it.
  const queries = callback(lazyTag);
  const client = await getPool().connect();
  return runQueriesOnClient(client, queries);
}

/** Test seam: exercises the transaction/rollback/release logic against an injected client, without a real pool. */
export async function __transactionWithClientForTests(
  client: TransactionClient,
  callback: (tx: PgTransactionTag) => PgLazyQuery[]
): Promise<PgSqlResult[]> {
  const lazyTag: PgTransactionTag = (strings, ...values) => ({
    text: buildText(strings, values),
    values,
  });
  return runQueriesOnClient(client, callback(lazyTag));
}

/** Ends the pool's connections. Call this when a short-lived process (a CLI script) is done making queries, so it does not hang on an idle pooled client. */
export async function closePgSqlPool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

/** Test seam: drop the cached pool so a newly set `DATABASE_URL` takes effect on the next call. */
export async function __resetPgSqlPoolForTests(): Promise<void> {
  await closePgSqlPool();
}
