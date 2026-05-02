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

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');

type Sql = NeonQueryFunction<false, true>;

function getSql(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return neon(url, { fullResults: true });
}

async function ensureTrackingTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function getAppliedVersions(sql: Sql): Promise<Set<string>> {
  const { rows } = await sql`SELECT version FROM schema_migrations`;
  return new Set((rows as Array<{ version: string }>).map((r) => r.version));
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

function splitStatements(sqlText: string): string[] {
  // Strip line comments. Multi-line comments not used in our migrations.
  const stripped = sqlText
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  // Split on semicolons. Our migrations contain no semicolons inside strings
  // or identifiers; if that ever changes, swap this for a real parser.
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyFile(sql: Sql, filename: string): Promise<void> {
  const filePath = join(MIGRATIONS_DIR, filename);
  const content = readFileSync(filePath, 'utf8');
  const statements = splitStatements(content);
  for (const stmt of statements) {
    await sql.query(stmt, []);
  }
  await sql`
    INSERT INTO schema_migrations (version) VALUES (${filename})
  `;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  const sql = getSql();

  await ensureTrackingTable(sql);
  const applied = await getAppliedVersions(sql);
  const all = listMigrationFiles();
  const pending = all.filter((name) => !applied.has(name));

  if (pending.length === 0) {
    console.log(`[migrate] up to date — ${all.length} migrations applied`);
    return;
  }

  console.log(
    `[migrate] ${pending.length} pending migration${pending.length === 1 ? '' : 's'}:`,
  );
  for (const name of pending) console.log(`  - ${name}`);

  if (dryRun) {
    console.log('[migrate] --dry: not applying');
    return;
  }

  for (const name of pending) {
    process.stdout.write(`[migrate] applying ${name} ... `);
    try {
      await applyFile(sql, name);
      console.log('ok');
    } catch (err) {
      console.log('FAIL');
      console.error(`[migrate] ${name} failed:`, err);
      process.exitCode = 1;
      return;
    }
  }
  console.log('[migrate] done');
}

main().catch((err) => {
  console.error('[migrate] runner error:', err);
  process.exit(1);
});
