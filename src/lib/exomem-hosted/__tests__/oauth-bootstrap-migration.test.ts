import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const migration = resolve(
  process.cwd(),
  "migrations/0044_exomem_marketplace_reviewer_oauth_bootstrap.sql"
);

// Number 0088 was merged twice on 2026-11-23 (#318 and #319). The runner
// records applied migrations by filename, and a production deploy may already
// have recorded both, so renaming either could re-run it. This one pair stays;
// the two touch disjoint objects. Every other number must be unique.
const APPLIED_DUPLICATE_NAMES = new Set([
  "0088_exomem_cloud_service_credentials.sql",
  "0088_exomem_standard_mcp_clients.sql",
]);

test("numbered migration identities are unique and monotonic", () => {
  const names = readdirSync(resolve(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  const identities = names.map((name) => Number(name.slice(0, 4)));
  const counted = names
    .filter((name) => !APPLIED_DUPLICATE_NAMES.has(name))
    .map((name) => Number(name.slice(0, 4)));
  assert.equal(new Set(counted).size, counted.length);
  assert.equal(
    new Set(
      names.filter((name) => APPLIED_DUPLICATE_NAMES.has(name)).map((name) => name.slice(0, 4))
    ).size,
    1,
    "the recorded duplicate pair shares one number"
  );
  assert.ok(
    !counted.includes(88),
    "no other migration may take the number of the recorded duplicate pair"
  );
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
