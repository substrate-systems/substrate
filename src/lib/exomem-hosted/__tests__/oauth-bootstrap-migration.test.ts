import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const migration = resolve(
  process.cwd(),
  "migrations/0044_exomem_marketplace_reviewer_oauth_bootstrap.sql"
);

test("numbered migration identities are unique and monotonic", () => {
  const names = readdirSync(resolve(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  const identities = names.map((name) => Number(name.slice(0, 4)));
  assert.equal(new Set(identities).size, identities.length);
  assert.deepEqual(
    identities,
    identities.toSorted((a, b) => a - b)
  );
});

test("reviewer OAuth bootstrap is a one-shot authority with transaction lineage", () => {
  assert.equal(existsSync(migration), true);
  const sql = readFileSync(migration, "utf8");

  assert.match(sql, /CREATE TABLE exomem_marketplace_reviewer_oauth_bootstrap_authorities/i);
  assert.match(sql, /state IN \('active', 'consumed', 'revoked', 'expired'\)/i);
  assert.match(sql, /candidate_source_release text NOT NULL/i);
  assert.match(sql, /candidate_protocol_version text NOT NULL/i);
  assert.match(sql, /candidate_gateway_contract_digest text NOT NULL/i);
  assert.match(sql, /candidate_command_fingerprint text NOT NULL/i);
  assert.match(sql, /candidate_schema_digest text NOT NULL/i);
  assert.match(sql, /candidate_compatibility_digest text NOT NULL/i);
  assert.match(sql, /state = 'revoked'[\s\S]*outcome_tenant_id IS NULL/i);
  assert.match(sql, /state = 'expired'[\s\S]*outcome_tenant_id IS NULL/i);
  assert.match(sql, /OLD\.state <> 'active' AND NEW IS DISTINCT FROM OLD/i);
  assert.match(sql, /WHERE state = 'active'/i);
  assert.match(sql, /reviewer_bootstrap_authority_id uuid/i);
  assert.match(sql, /ON DELETE RESTRICT/i);
  assert.match(sql, /UNIQUE INDEX[\s\S]*reviewer_bootstrap_authority_id/i);
  assert.match(
    sql,
    /candidate_id IS NULL[\s\S]*assignment_id IS NULL[\s\S]*staged_client_release_id IS NULL/i
  );
});
