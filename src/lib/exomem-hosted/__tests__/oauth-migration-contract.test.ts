import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const oauthMigration = resolve(process.cwd(), "migrations/0025_exomem_mcp_oauth.sql");
const capacityMigration = resolve(process.cwd(), "migrations/0026_exomem_capacity.sql");

describe("Exomem OAuth and capacity migrations", () => {
  it("keeps OAuth credentials digest-only and one-time", () => {
    const sql = readFileSync(oauthMigration, "utf8");
    for (const table of [
      "exomem_oauth_clients",
      "exomem_oauth_authorization_transactions",
      "exomem_oauth_grants",
      "exomem_oauth_authorization_codes",
      "exomem_oauth_token_families",
      "exomem_oauth_refresh_tokens",
      "exomem_oauth_access_tokens",
      "exomem_agent_contracts",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
    }
    assert.match(sql, /code_digest bytea NOT NULL UNIQUE/i);
    assert.match(sql, /refresh_digest bytea NOT NULL UNIQUE/i);
    assert.match(sql, /access_digest bytea NOT NULL UNIQUE/i);
    assert.match(sql, /consumed_at timestamptz/i);
    assert.match(sql, /revoked_at timestamptz/i);
    assert.match(sql, /oauth_security_schemes jsonb NOT NULL/i);
    assert.doesNotMatch(sql, /raw_(?:code|token|secret)/i);
  });

  it("separates conservative capacity from OAuth state without provider calls", () => {
    const sql = readFileSync(capacityMigration, "utf8");
    for (const table of [
      "exomem_capacity_pools",
      "exomem_capacity_allocations",
      "exomem_capacity_claims",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
    }
    assert.match(
      sql,
      /storage_capacity_bytes bigint NOT NULL CHECK \(storage_capacity_bytes >= 0\)/i
    );
    assert.match(sql, /provision_reservation_capacity integer NOT NULL/i);
    assert.match(sql, /reserved_storage_bytes bigint NOT NULL DEFAULT 0/i);
    assert.match(sql, /configured_at timestamptz/i);
    assert.match(sql, /storage_bytes bigint NOT NULL CHECK \(storage_bytes > 0\)/i);
    assert.match(sql, /provision_slots integer NOT NULL CHECK \(provision_slots >= 0\)/i);
    assert.match(sql, /state <> 'reserved' OR provision_slots > 0/i);
    assert.match(sql, /'occupied'/i);
    assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
    assert.doesNotMatch(sql, /https?:\/\//i);
  });
});
