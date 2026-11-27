/** One isolated PostgreSQL schema with every migration applied, for a suite that runs against a real database. */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../../scripts/migrate";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../../db";
import { ensureExomemPostgresTestExtensions } from "../../__tests__/postgres-test-extensions";

function taggedSql(client: Pool | PoolClient, onStatement?: (text: string) => void): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    onStatement?.(text);
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

/** `onStatement` sees the text of every statement the code under test issues, so a test can run the real query through EXPLAIN. */
export async function openIsolatedSchema(
  prefix: string,
  databaseUrl: string,
  onStatement?: (text: string) => void
) {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  await ensureExomemPostgresTestExtensions(databaseUrl);
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  await applyMigrations({
    databaseUrl: scoped.toString(),
    migrationsDir: resolve(process.cwd(), "migrations"),
  });
  const pool = new Pool({ connectionString: scoped.toString() });
  __setExomemSqlForTests(taggedSql(pool, onStatement));
  __setExomemTransactionForTests(async (callback) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(taggedSql(client, onStatement));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  return {
    pool,
    async close() {
      __setExomemSqlForTests(null);
      __setExomemTransactionForTests(null);
      await pool.end();
      const cleanup = new Pool({ connectionString: databaseUrl });
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanup.end();
    },
  };
}
