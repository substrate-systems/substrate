import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Exomem agent-contract artifact migration", () => {
  it("keeps contract candidates and client artifacts additive and tenant-neutral", () => {
    const sql = readFileSync(resolve(process.cwd(), "migrations/0028_exomem_agent_contract_artifacts.sql"), "utf8");
    for (const table of [
      "exomem_agent_contract_candidates",
      "exomem_routable_cell_contracts",
      "exomem_client_artifacts",
    ]) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`));
    assert.match(sql, /state IN \('pending', 'live', 'failed', 'retired'\)/i);
    assert.match(sql, /exomem_agent_contract_candidates_one_live_idx/i);
    assert.match(sql, /exomem_client_artifacts_one_live_idx/i);
    assert.match(sql, /exomem_agent_contract_profile_authority/i);
    assert.match(sql, /routable_set_digest text NOT NULL/i);
    assert.match(sql, /state IN \('live', 'retired'\)/i);
    assert.doesNotMatch(sql, /\bdigest\s*\(/i);
    assert.match(sql, /CHECK \(install_url ~ '\^https:\/\/'\)/i);
    assert.match(sql, /client_identity_sha256 text NOT NULL/i);
    assert.match(sql, /paired_run_hmac_sha256 text NOT NULL/i);
    assert.match(sql, /exomem_identity_hmac_sha256 text NOT NULL/i);
    assert.match(sql, /tenant_hmac_sha256 text NOT NULL/i);
    assert.match(sql, /claude_package_lock jsonb NOT NULL/i);
    assert.match(sql, /openai_package_lock jsonb/i);
    assert.doesNotMatch(sql, /client_identity text/i);
    assert.match(sql, /state = 'failed' AND promoted_at IS NOT NULL AND retired_at IS NULL AND failed_at IS NOT NULL/i);
    assert.doesNotMatch(sql, /(?:token|tenant_selector|cell_endpoint|prompt|result_text)\s+(?:text|jsonb)/i);
  });
});
