import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
}

test("fresh hosted schema fences magic links with tenant and token generations", () => {
  const sql = migration("0017_exomem_hosted_service.sql");
  assert.match(sql, /magic_link_generation bigint NOT NULL DEFAULT 0/i);
  assert.match(sql, /magic_link_generation bigint[,\s]/i);
  assert.match(sql, /purpose = 'magic_link'[\s\S]*magic_link_generation IS NOT NULL/i);
  assert.match(sql, /purpose = 'deletion_confirmation'[\s\S]*magic_link_generation IS NULL/i);
});

test("draft-schema upgrade assigns generations and revokes unsafe legacy links", () => {
  const sql = migration("0018_exomem_access_browser_challenge.sql");
  assert.match(
    sql,
    /ALTER TABLE exomem_tenants[\s\S]*ADD COLUMN IF NOT EXISTS magic_link_generation/i
  );
  assert.match(
    sql,
    /ALTER TABLE exomem_access_tokens[\s\S]*ADD COLUMN IF NOT EXISTS magic_link_generation/i
  );
  assert.match(sql, /row_number\(\)[\s\S]*PARTITION BY user_id, tenant_id/i);
  assert.match(sql, /LEGACY_MAGIC_LINK_REVOKED/i);
  assert.match(sql, /SUPERSEDED_MAGIC_LINK/i);
  assert.match(sql, /exomem_access_tokens_magic_link_generation_check/i);
});
