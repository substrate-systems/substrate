import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migrationPath = resolve(
  process.cwd(),
  "migrations/0035_exomem_marketplace_reviewer_access.sql"
);

test("reviewer access persists provider-scoped secret digests and session attribution", () => {
  const sql = readFileSync(migrationPath, "utf8");

  assert.match(sql, /CREATE TABLE exomem_marketplace_reviewer_credentials/i);
  assert.match(sql, /ADD COLUMN marketplace_reviewer_purpose boolean NOT NULL DEFAULT false/i);
  assert.match(
    sql,
    /ALTER TABLE exomem_invites\s+ADD COLUMN marketplace_reviewer_purpose boolean NOT NULL DEFAULT false/i
  );
  assert.match(sql, /CREATE RULE exomem_tenants_reviewer_purpose_immutable/i);
  assert.match(
    sql,
    /ON UPDATE TO exomem_tenants[\s\S]*NEW\.marketplace_reviewer_purpose IS DISTINCT FROM OLD\.marketplace_reviewer_purpose[\s\S]*DO INSTEAD NOTHING/i
  );
  assert.match(sql, /provider text NOT NULL CHECK \(provider IN \('openai', 'anthropic'\)\)/i);
  assert.match(sql, /username_digest bytea NOT NULL UNIQUE/i);
  assert.match(sql, /password_hash text NOT NULL/i);
  assert.match(sql, /fixture_version text NOT NULL/i);
  assert.match(
    sql,
    /fixture_payload_digest text NOT NULL CHECK \(fixture_payload_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/i
  );
  assert.match(sql, /expires_at timestamptz NOT NULL/i);
  assert.match(sql, /revoked_at timestamptz/i);
  assert.match(sql, /octet_length\(username_digest\) = 32/i);
  assert.match(sql, /password_hash LIKE '\$argon2id\$%'/i);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX exomem_marketplace_reviewer_credentials_active_provider_idx[\s\S]*WHERE revoked_at IS NULL/i
  );
  assert.match(
    sql,
    /ADD COLUMN reviewer_credential_id uuid REFERENCES exomem_marketplace_reviewer_credentials\(id\) ON DELETE SET NULL/i
  );
  assert.match(
    sql,
    /ALTER TABLE exomem_oauth_authorization_transactions[\s\S]*ADD COLUMN reviewer_credential_id uuid REFERENCES exomem_marketplace_reviewer_credentials\(id\) ON DELETE SET NULL/i
  );
  assert.match(
    sql,
    /ALTER TABLE exomem_oauth_grants[\s\S]*ADD COLUMN reviewer_credential_id uuid REFERENCES exomem_marketplace_reviewer_credentials\(id\) ON DELETE SET NULL/i
  );
  assert.match(sql, /exomem_oauth_authorization_transactions_reviewer_credential_active_idx/i);
  assert.match(sql, /exomem_oauth_grants_reviewer_credential_active_idx/i);
  assert.match(
    sql,
    /CREATE INDEX exomem_sessions_reviewer_credential_active_idx[\s\S]*WHERE reviewer_credential_id IS NOT NULL AND revoked_at IS NULL/i
  );
  assert.doesNotMatch(sql, /DO\s+\$\$/i);
});
