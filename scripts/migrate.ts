/**
 * Database migration runner for Hosted Backup.
 *
 * Reads migrations/*.sql in filename order and applies any that have not yet
 * been recorded in the schema_migrations tracking table. The tracking table
 * itself is created by this script on first invocation, not by a numbered
 * migration file (avoids the chicken-and-egg of a migration that creates the
 * migrations table).
 *
 * Statements within a migration file are split on `;` boundaries and run
 * sequentially. Each FILE is treated as the unit of recording: either every
 * statement applied successfully and the row was inserted, or the run aborts
 * and the file is left to be retried.
 *
 * Usage:
 *   tsx scripts/migrate.ts        # apply pending migrations
 *   tsx scripts/migrate.ts --dry  # list pending migrations without applying
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientBase } from "pg";

const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), "migrations");
const MIGRATION_LOCK_NAMESPACE = 0x45584f4d; // "EXOM"
const MIGRATION_LOCK_ID = 0x454d; // "EM"
const RELEASE_A_MIGRATION = "0040_backup_version_commit.sql";

type Sql = Pick<ClientBase, "query">;

export async function assertExpectedMigrationSchema(
  sql: Sql,
  expectedSchema: string
): Promise<void> {
  const { rows } = await sql.query<{ schema_name: string | null }>(
    "SELECT current_schema() AS schema_name"
  );
  if (rows[0]?.schema_name !== expectedSchema) {
    throw new Error("EXOMEM_STAGING_SCHEMA_UNAVAILABLE");
  }
}

function getClient(databaseUrl?: string): Client {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Client({ connectionString: url });
}

async function ensureTrackingTable(sql: Sql): Promise<void> {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedVersions(sql: Sql): Promise<Set<string>> {
  const { rows } = await sql.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set((rows as Array<{ version: string }>).map((r) => r.version));
}

function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

function splitStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let inSingleQuote = false;
  let dollarQuote: string | null = null;

  for (let index = 0; index < sqlText.length; index += 1) {
    const character = sqlText[index];
    if (dollarQuote) {
      if (sqlText.startsWith(dollarQuote, index)) {
        statement += dollarQuote;
        index += dollarQuote.length - 1;
        dollarQuote = null;
      } else {
        statement += character;
      }
      continue;
    }
    if (inSingleQuote) {
      statement += character;
      if (character === "'") {
        if (sqlText[index + 1] === "'") {
          statement += sqlText[index + 1];
          index += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }
    if (character === "'") {
      inSingleQuote = true;
      statement += character;
      continue;
    }
    if (character === "-" && sqlText[index + 1] === "-") {
      const newline = sqlText.indexOf("\n", index + 2);
      if (newline < 0) break;
      statement += "\n";
      index = newline;
      continue;
    }
    if (character === "$") {
      const opening = sqlText.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (opening) {
        dollarQuote = opening;
        statement += opening;
        index += opening.length - 1;
        continue;
      }
    }
    if (character === ";") {
      const trimmed = statement.trim();
      if (trimmed) statements.push(trimmed);
      statement = "";
      continue;
    }
    statement += character;
  }
  const trimmed = statement.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

async function applyFile(sql: Sql, migrationsDir: string, filename: string): Promise<void> {
  const filePath = join(migrationsDir, filename);
  const content = readFileSync(filePath, "utf8");
  const statements = splitStatements(content);
  await sql.query("BEGIN");
  try {
    for (const statement of statements) {
      await sql.query(statement, []);
    }
    await sql.query("INSERT INTO schema_migrations (version) VALUES ($1)", [filename]);
    await sql.query("COMMIT");
  } catch (error) {
    await sql.query("ROLLBACK");
    throw error;
  }
}

/**
 * Apply all pending migrations (or list them, if `dry: true`).
 *
 * Exported so `scripts/vercel-maybe-migrate.ts` can call the same code path
 * during Vercel production builds without spawning a child process. Throws on
 * any migration failure so callers can decide whether to abort the build /
 * non-zero exit / etc.
 */
export async function applyMigrations(
  opts: {
    dry?: boolean;
    databaseUrl?: string;
    migrationsDir?: string;
    expectedSchema?: string;
  } = {}
): Promise<void> {
  const { dry = false, migrationsDir = DEFAULT_MIGRATIONS_DIR } = opts;
  const client = getClient(opts.databaseUrl);
  await client.connect();
  let locked = false;
  try {
    if (opts.expectedSchema) {
      await assertExpectedMigrationSchema(client, opts.expectedSchema);
    }
    // A session lock is held on this dedicated connection across the applied
    // version recheck and every per-file transaction. A crashed runner drops
    // the connection and releases it automatically.
    await client.query("SELECT pg_advisory_lock($1, $2)", [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_ID,
    ]);
    locked = true;
    await ensureTrackingTable(client);
    const applied = await getAppliedVersions(client);
    const all = listMigrationFiles(migrationsDir);
    const pending = all.filter((name) => !applied.has(name));

    if (
      !dry &&
      pending.includes(RELEASE_A_MIGRATION) &&
      process.env.CONFIRM_ENDSTATE_CLOUD_RELEASE_A !== "yes"
    ) {
      throw new Error(
        `${RELEASE_A_MIGRATION} is a controlled Release-A migration; set CONFIRM_ENDSTATE_CLOUD_RELEASE_A=yes only for the approved rollout`
      );
    }

    if (pending.length === 0) {
      console.log(`[migrate] up to date — ${all.length} migrations applied`);
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration${pending.length === 1 ? "" : "s"}:`);
    for (const name of pending) console.log(`  - ${name}`);

    if (dry) {
      console.log("[migrate] --dry: not applying");
      return;
    }

    for (const name of pending) {
      process.stdout.write(`[migrate] applying ${name} ... `);
      try {
        await applyFile(client, migrationsDir, name);
        console.log("ok");
      } catch (err) {
        console.log("FAIL");
        throw new Error(
          `migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    console.log("[migrate] done");
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_NAMESPACE, MIGRATION_LOCK_ID])
        .catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

// CLI entry point. Only runs when invoked directly (`tsx scripts/migrate.ts`)
// — not when imported as a module by `vercel-maybe-migrate.ts`. Standard ESM
// idiom: compare process.argv[1] against the file path of this module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  applyMigrations({ dry: process.argv.includes("--dry") }).catch((err) => {
    console.error("[migrate] runner error:", err);
    process.exit(1);
  });
}
