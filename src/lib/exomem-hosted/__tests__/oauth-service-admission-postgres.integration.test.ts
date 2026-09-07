import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemSql,
} from "../db";
import { resolveApprovedOAuthClient } from "../oauth-store";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
const clientId = "https://approved-without-artifact.example.test/metadata.json";
let pool: Pool | undefined;
let schema: string | undefined;

function sql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function transaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await work(sql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("approved service client PostgreSQL admission", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `oauth_service_admission_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
    await pool.query(
      `INSERT INTO exomem_oauth_clients (
         client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
         client_platform, oauth_client_config_sha256
       ) VALUES ($1, 'pinned', true, '["https://approved-without-artifact.example.test/callback"]'::jsonb,
                 digest(convert_to('["https://approved-without-artifact.example.test/callback"]'::jsonb::text, 'utf8'), 'sha256'),
                 'claude', $2)`,
      [clientId, "a".repeat(64)]
    );
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("admits an approved pinned client without a certified artifact", async () => {
    assert.equal((await resolveApprovedOAuthClient(clientId))?.clientId, clientId);
  });
});
