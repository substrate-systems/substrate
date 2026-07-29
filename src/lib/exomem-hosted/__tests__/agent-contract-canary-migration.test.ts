import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Exomem Hosted canary migration", () => {
  it("adds only durable canary authority and leaves every existing cohort untouched", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "migrations/0036_exomem_agent_contract_canaries.sql"),
      "utf8"
    );

    for (const table of [
      "exomem_agent_contract_rollout_assignments",
      "exomem_staged_client_releases",
    ])
      assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
    assert.match(sql, /state IN \('preparing', 'active', 'failed', 'expired', 'retired'\)/i);
    assert.match(sql, /state IN \('staged', 'evidenced', 'failed', 'expired', 'retired'\)/i);
    assert.match(sql, /exomem_agent_contract_rollout_assignments_one_current_idx/i);
    assert.match(sql, /exomem_staged_client_releases_candidate_platform_current_idx/i);
    assert.match(sql, /gateway_contract_digest text NOT NULL/i);
    assert.match(sql, /marketplace_reviewer_purpose boolean NOT NULL/i);
    assert.match(sql, /CHECK \(expires_at > created_at\)/i);
    assert.doesNotMatch(sql, /CREATE INDEX CONCURRENTLY/i);
    assert.doesNotMatch(sql, /INSERT INTO exomem_agent_contract_rollout_assignments/i);
    assert.doesNotMatch(sql, /INSERT INTO exomem_staged_client_releases/i);
    assert.doesNotMatch(sql, /UPDATE exomem_agent_contract_candidates/i);
    assert.doesNotMatch(sql, /(?:provider|token|revoke|credential)/i);
  });
});
