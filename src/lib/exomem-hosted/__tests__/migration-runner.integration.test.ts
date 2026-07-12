import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe("migration runner PostgreSQL integration", { skip: !databaseUrl }, () => {
  it("serializes concurrent runners and rechecks versions after the lock", async () => {
    const schema = `migration_lock_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: databaseUrl });
    const directory = mkdtempSync(join(tmpdir(), "exomem-migrations-"));
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      writeFileSync(
        join(directory, "0001_lock_probe.sql"),
        "CREATE TABLE lock_probe (id integer PRIMARY KEY);\n" +
          "INSERT INTO lock_probe (id) VALUES (1);\n",
        "utf8"
      );
      const scopedUrl = new URL(databaseUrl!);
      scopedUrl.searchParams.set("options", `-c search_path=${schema}`);

      await Promise.all([
        applyMigrations({ databaseUrl: scopedUrl.toString(), migrationsDir: directory }),
        applyMigrations({ databaseUrl: scopedUrl.toString(), migrationsDir: directory }),
      ]);

      const probe = await admin.query(`SELECT id FROM "${schema}".lock_probe`);
      const applied = await admin.query(
        `SELECT version FROM "${schema}".schema_migrations ORDER BY version`
      );
      assert.deepEqual(probe.rows, [{ id: 1 }]);
      assert.deepEqual(applied.rows, [{ version: "0001_lock_probe.sql" }]);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
