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
const paddleReconciliationPath = resolve(
  process.cwd(),
  "migrations/0020_exomem_paddle_reconciliation.sql"
);
const paddleProvenancePath = resolve(
  process.cwd(),
  "migrations/0021_exomem_paddle_provider_provenance.sql"
);
const exportIntentPath = resolve(process.cwd(), "migrations/0022_exomem_export_request_intent.sql");
const legacyCapacityPath = resolve(
  process.cwd(),
  "migrations/0030_exomem_capacity_legacy_mode.sql"
);
const provisionerWireProtocolPath = resolve(
  process.cwd(),
  "migrations/0037_exomem_provisioner_v2_runtime_identity.sql"
);

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

  it("persists exact export request expiry and contact intent across retries", () => {
    const sql = readFileSync(exportIntentPath, "utf8");
    assert.match(sql, /ADD COLUMN export_expires_at timestamptz/i);
    assert.match(sql, /ADD COLUMN export_request_started boolean NOT NULL DEFAULT false/i);
    assert.match(sql, /export_request_started[\s\S]*export_expires_at IS NOT NULL/i);
    assert.match(sql, /operation_type = 'export'/i);
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
    assert.match(sql, /UPDATE exomem_lifecycle_operations AS operation[\s\S]*input_export_id/i);
    assert.match(sql, /operation\.input_reference_digest = export_row\.storage_reference_digest/i);
    assert.match(sql, /exomem_lifecycle_active_restore_export_pin_check/i);
    assert.match(sql, /FOREIGN KEY \(tenant_id, input_export_id\)/i);
    assert.match(sql, /REFERENCES exomem_exports\(tenant_id, id\)/i);
    assert.match(sql, /export_release_reference_ciphertext jsonb/i);
    assert.match(sql, /gc_lease_owner text/i);
    assert.match(sql, /gc_next_attempt_at timestamptz/i);
    assert.match(sql, /state = 'deleted'[\s\S]*storage_reference_digest IS NULL/i);
    assert.match(sql, /provider_deleted_at IS NOT NULL/i);
    assert.match(sql, /provider_deleted_at = export_row\.deleted_at/i);
  });

  it("adds durable scheduling, leasing, and bounded retry state for Paddle reconciliation", () => {
    const sql = readFileSync(paddleReconciliationPath, "utf8");
    for (const column of [
      "provider_reconcile_after",
      "provider_reconciled_at",
      "provider_reconcile_lease_owner",
      "provider_reconcile_lease_expires_at",
      "provider_reconcile_attempts",
      "provider_reconcile_error_code",
    ]) {
      assert.match(sql, new RegExp(`ADD COLUMN ${column}`, "i"));
    }
    assert.match(sql, /provider_reconcile_attempts >= 0/i);
    assert.match(
      sql,
      /\(provider_reconcile_lease_owner IS NULL\)\s*=\s*\(provider_reconcile_lease_expires_at IS NULL\)/i
    );
    assert.match(sql, /exomem_entitlements_provider_reconcile_ready_idx/i);
    assert.match(sql, /WHERE source = 'paddle'/i);
    assert.match(sql, /provider_subscription_ref IS NOT NULL/i);
    assert.match(sql, /source_state <> 'cancelled'/i);
    assert.doesNotMatch(sql, /DO\s+\$\$/i);
    assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it("adds receipt-backed Paddle environment provenance without guessing ambiguous legacy rows", () => {
    const sql = readFileSync(paddleProvenancePath, "utf8");
    assert.match(sql, /ADD COLUMN provider_environment text/i);
    assert.match(sql, /provider_environment IN \('sandbox', 'production'\)/i);
    assert.match(sql, /UPDATE exomem_entitlements AS entitlement[\s\S]*exomem_paddle_events/i);
    assert.match(sql, /COUNT\s*\(\s*DISTINCT\s+(?:receipt\.)?environment\s*\)\s*=\s*1/i);
    assert.match(sql, /CASE[\s\S]*'live'[\s\S]*'production'/i);
    assert.match(sql, /ADD COLUMN provider_provenance_unresolved_fingerprint text/i);
    assert.match(sql, /exomem_entitlements_provider_reference_provenance_check[\s\S]*NOT VALID/i);
    assert.match(sql, /provider_transaction_ref IS NULL[\s\S]*source\s*=\s*'paddle'/i);
    assert.match(sql, /provider_provenance_unresolved_fingerprint[\s\S]*provider_customer_ref/i);
    assert.match(
      sql,
      /source\s*=\s*'paddle'[\s\S]*provider_environment IS NOT NULL[\s\S]*provider_environment IN/i
    );

    for (const reference of ["customer", "subscription", "transaction"]) {
      assert.match(
        sql,
        new RegExp(
          `CREATE UNIQUE INDEX exomem_entitlements_provider_${reference}_environment_idx[\\s\\S]*\\(provider_environment, provider_${reference}_ref\\)[\\s\\S]*WHERE[^;]*provider_${reference}_ref IS NOT NULL`,
          "i"
        )
      );
    }
    assert.doesNotMatch(sql, /DO\s+\$\$/i);
    assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it("requires an explicit marker before admitting legacy unmetered capacity", () => {
    const sql = readFileSync(legacyCapacityPath, "utf8");
    assert.match(sql, /ADD COLUMN legacy_unmetered boolean NOT NULL DEFAULT false/i);
  });

  it("persists an immutable v1 or v2 provisioner wire protocol without duplicating targets", () => {
    const sql = readFileSync(provisionerWireProtocolPath, "utf8");

    assert.match(sql, /ADD COLUMN provisioner_wire_protocol text/i);
    assert.match(
      sql,
      /UPDATE exomem_lifecycle_operations[\s\S]*SET provisioner_wire_protocol = 'exomem-cell-provisioner\.v1'/i
    );
    assert.match(
      sql,
      /ALTER COLUMN provisioner_wire_protocol SET DEFAULT 'exomem-cell-provisioner\.v1'/i
    );
    assert.match(sql, /ALTER COLUMN provisioner_wire_protocol SET NOT NULL/i);
    assert.match(
      sql,
      /provisioner_wire_protocol IN \(\s*'exomem-cell-provisioner\.v1',\s*'exomem-cell-provisioner\.v2'\s*\)/i
    );
    assert.match(sql, /provisioner_wire_protocol <> 'exomem-cell-provisioner\.v2'/i);
    assert.match(sql, /operation_type = 'delete'/i);
    assert.match(sql, /cell_id IS NULL/i);
    assert.match(sql, /CREATE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable/i);
    assert.match(sql, /CREATE TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable/i);
    assert.doesNotMatch(sql, /ADD COLUMN target_/i);
    assert.doesNotMatch(sql, /ADD COLUMN observed_/i);
    assert.doesNotMatch(sql, /INSERT INTO|DELETE FROM/i);
    assert.doesNotMatch(
      sql,
      /(?:UPDATE|INSERT INTO|DELETE FROM)\s+exomem_(?:agent_contract_candidates|agent_contract_rollout_assignments|oauth|cells)/i
    );
  });
});
