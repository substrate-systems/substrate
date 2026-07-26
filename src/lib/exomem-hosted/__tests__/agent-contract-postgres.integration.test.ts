import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;

describe("agent contract PostgreSQL constraints", { skip: !databaseUrl }, () => {
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query("SELECT 1");
  });

  after(async () => {
    await pool?.end();
  });

  it("has pending candidate, artifact, and fenced authority tables", async () => {
    const { rows } = await pool!.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('exomem_agent_contract_candidates', 'exomem_client_artifacts', 'exomem_agent_contract_profile_authority')"
    );
    assert.deepEqual(rows.map((row) => row.table_name).sort(), [
      "exomem_agent_contract_candidates",
      "exomem_agent_contract_profile_authority",
      "exomem_client_artifacts",
    ]);
  });

  it("enforces one live artifact per platform while allowing pending replacement evidence", async () => {
    const { rows } = await pool!.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'exomem_client_artifacts_one_live_idx'"
    );
    assert.match(rows[0]?.indexdef ?? "", /WHERE \(state = 'live'\)/i);
  });
});
