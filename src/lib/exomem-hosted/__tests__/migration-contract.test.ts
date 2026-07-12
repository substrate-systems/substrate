import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const migrationPath = resolve(process.cwd(), "migrations/0017_exomem_hosted_service.sql");
const accessUpgradePath = resolve(
  process.cwd(),
  "migrations/0018_exomem_access_browser_challenge.sql"
);
const exportLifecyclePath = resolve(process.cwd(), "migrations/0019_exomem_export_lifecycle.sql");

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
      "exomem_exports",
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
    assert.match(sql, /browser_challenge_digest bytea/i);
    assert.match(sql, /octet_length\(browser_challenge_digest\) = 32/i);
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

  it("upgrades databases that applied the pre-challenge draft migration", () => {
    const sql = readFileSync(accessUpgradePath, "utf8");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS browser_challenge_digest bytea/i);
    assert.match(sql, /LEGACY_MAGIC_LINK_REVOKED/i);
    assert.match(sql, /secret_ciphertext = NULL/i);
    assert.match(sql, /ADD CONSTRAINT exomem_access_tokens_browser_challenge_check/i);
  });

  it("retains ignored Paddle receipts as a distinct terminal audit disposition", () => {
    assert.match(migration(), /disposition IN \([^)]*'ignored'[^)]*\)/i);
  });

  it("stores only encrypted verified export references and product-scoped deletion state", () => {
    const sql = migration();
    assert.match(sql, /storage_reference_ciphertext jsonb/i);
    assert.match(sql, /storage_reference_digest bytea NOT NULL UNIQUE/i);
    assert.match(sql, /integrity_verified boolean NOT NULL CHECK \(integrity_verified\)/i);
    assert.match(sql, /encryption_scheme = 'envelope-aes-256-gcm'/i);
    assert.match(sql, /input_reference_ciphertext jsonb/i);
    assert.match(sql, /input_archive_sha256 text/i);
    assert.match(sql, /input_manifest_sha256 text/i);
    assert.match(sql, /input_source_cell_id uuid/i);
    assert.match(sql, /input_destroyed_at timestamptz/i);
    assert.match(sql, /fence_generation bigint NOT NULL DEFAULT 1/i);
    assert.match(sql, /fence_generation bigint NOT NULL CHECK \(fence_generation > 0\)/i);
    assert.match(
      sql,
      /purpose text NOT NULL CHECK \(purpose IN \('magic_link', 'deletion_confirmation'\)\)/i
    );
    assert.match(sql, /CREATE TABLE exomem_access_delivery_outbox/i);
    assert.match(sql, /CREATE TABLE exomem_rate_limit_buckets/i);
    assert.match(sql, /secret_ciphertext jsonb/i);
    assert.match(sql, /lease_owner uuid/i);
    assert.match(sql, /lease_expires_at timestamptz/i);
    assert.match(sql, /UNIQUE REFERENCES exomem_access_tokens\(id\) ON DELETE CASCADE/i);
  });

  it("adds tenant-scoped restore pins and proof-gated export tombstones", () => {
    const sql = readFileSync(exportLifecyclePath, "utf8");
    assert.match(sql, /FOREIGN KEY \(tenant_id, input_export_id\)/i);
    assert.match(sql, /REFERENCES exomem_exports\(tenant_id, id\)/i);
    assert.match(sql, /export_release_reference_ciphertext jsonb/i);
    assert.match(sql, /gc_lease_owner text/i);
    assert.match(sql, /gc_next_attempt_at timestamptz/i);
    assert.match(sql, /state = 'deleted'[\s\S]*storage_reference_digest IS NULL/i);
    assert.match(sql, /provider_deleted_at IS NOT NULL/i);
  });
});
