import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { parseClientArtifact, promoteClientArtifact, demoteClientArtifact, storeClientArtifact } from "../client-artifacts";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;

const sha = (letter: string) => letter.repeat(64);
const target = { origin: "https://claude.ai", path: "/plugins/exomem-hosted" };

function sql(pool: Pool): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    const result = await pool.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

describe("agent contract PostgreSQL constraints", { skip: !databaseUrl }, () => {
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query("SELECT 1");
    __setExomemSqlForTests(sql(pool));
  });

  after(async () => {
    __setExomemSqlForTests(null);
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

  it("imports pending artifacts, rejects forged evidence, retires a prior live artifact, and demotes by CAS", async () => {
    const make = async (suffix: string) => {
      const artifact = parseClientArtifact({
        platform: "claude", state: "pending", packageSha256: sha("a"), archiveSha256: sha("b"),
        compatibilitySha256: sha("c"), contractSha256: sha("d"), pluginVersion: "0.1.0",
        clientIdentity: `claude-${suffix}`, installUrl: "https://claude.ai/plugins/exomem-hosted",
        evidenceSha256: sha("e"), resultSha256: sha("f"), observedAt: new Date().toISOString(),
      }, target);
      return { artifact, id: await storeClientArtifact(artifact) };
    };
    const sign = (id: string) => createHmac("sha256", "integration-secret").update(JSON.stringify({ artifactId: id, evidenceSha256: sha("e"), operatorKeyId: "operator", platform: "claude", resultSha256: sha("f") })).digest("hex");
    const first = await make(randomUUID());
    await assert.rejects(() => promoteClientArtifact({ artifactId: first.id, platform: "claude", evidenceSha256: sha("e"), resultSha256: sha("f"), operatorKeyId: "operator", trustedKeyId: "operator", trustedSecret: "integration-secret", signature: sha("0") }), /signature is invalid/i);
    assert.equal(await promoteClientArtifact({ artifactId: first.id, platform: "claude", evidenceSha256: sha("e"), resultSha256: sha("f"), operatorKeyId: "operator", trustedKeyId: "operator", trustedSecret: "integration-secret", signature: sign(first.id) }), true);
    const second = await make(randomUUID());
    assert.equal(await promoteClientArtifact({ artifactId: second.id, platform: "claude", evidenceSha256: sha("e"), resultSha256: sha("f"), operatorKeyId: "operator", trustedKeyId: "operator", trustedSecret: "integration-secret", signature: sign(second.id) }), true);
    const states = await pool!.query("SELECT state FROM exomem_client_artifacts WHERE id = ANY($1::uuid[])", [[first.id, second.id]]);
    assert.deepEqual(states.rows.map((row) => row.state).sort(), ["live", "retired"]);
    assert.equal(await demoteClientArtifact(second.id, sha("9")), true);
    assert.equal(await demoteClientArtifact(second.id, sha("9")), false);
  });
});
