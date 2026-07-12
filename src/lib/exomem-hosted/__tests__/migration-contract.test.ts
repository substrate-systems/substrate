import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migrationPath = resolve(process.cwd(), "migrations/0017_exomem_hosted_service.sql");

function migration(): string {
  return readFileSync(migrationPath, "utf8");
}

describe("Exomem hosted migration contract", () => {
  it("creates every product-scoped foundation table", () => {
    const sql = migration();
    for (const table of [
      "exomem_tenants",
      "exomem_cells",
      "exomem_entitlements",
      "exomem_sessions",
      "exomem_access_tokens",
      "exomem_invites",
      "exomem_lifecycle_operations",
      "exomem_transfer_grants",
      "exomem_paddle_events",
      "exomem_audit_events",
    ]) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
    }
  });

  it("enforces one owner, one bound cell, single-use digests, and leased idempotency", () => {
    const sql = migration();
    assert.match(sql, /owner_user_id uuid NOT NULL UNIQUE/i);
    assert.match(sql, /bound_cell_id uuid/i);
    assert.match(
      sql,
      /FOREIGN KEY \(id, bound_cell_id\)[\s\S]*REFERENCES exomem_cells \(tenant_id, id\)/i
    );
    assert.match(
      sql,
      /CREATE UNIQUE INDEX exomem_cells_one_bound_per_tenant_idx[\s\S]*WHERE routing_state = 'bound'/i
    );
    assert.match(sql, /token_digest bytea NOT NULL UNIQUE/i);
    assert.match(sql, /session_digest bytea NOT NULL UNIQUE/i);
    assert.match(sql, /CHECK \(octet_length\(token_digest\) = 32\)/i);
    assert.match(sql, /UNIQUE \(tenant_id, operation_type, idempotency_key\)/i);
    assert.match(sql, /lease_expires_at timestamptz/i);
    assert.match(sql, /next_attempt_at timestamptz/i);
  });

  it("allows an unbound restoring candidate beside the bound active cell", () => {
    const sql = migration();
    assert.match(
      sql,
      /routing_state text NOT NULL DEFAULT 'unbound'[\s\S]*CHECK \(routing_state IN \('unbound', 'bound', 'retiring'\)\)/i
    );
    assert.match(sql, /'restoring'/i);
    assert.doesNotMatch(
      sql,
      /CREATE UNIQUE INDEX exomem_cells_one_bound_per_tenant_idx[\s\S]{0,160}restoring/i
    );
    assert.match(sql, /WHERE routing_state = 'bound'/i);
  });

  it("stays compatible with the repository's semicolon splitter", () => {
    const sql = migration();
    assert.doesNotMatch(sql, /DO\s+\$\$/i);
    assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  });
});
