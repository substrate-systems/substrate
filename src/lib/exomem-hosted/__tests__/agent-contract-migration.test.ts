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
    assert.match(sql, /CHECK \(install_url ~ '\^https:\/\/'\)/i);
    assert.doesNotMatch(sql, /(?:token|tenant_selector|cell_endpoint|prompt|result_text)\s+(?:text|jsonb)/i);
  });
});
