import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { parseClientArtifact, promoteClientArtifact, demoteClientArtifact, storeClientArtifact } from "../client-artifacts";
import {
  EXOMEM_HOSTED_PROFILE,
  parseExomemAgentContractCandidate,
  promoteExomemAgentContractCandidate,
  recordRoutableCellObservation,
  storeExomemAgentContractCandidate,
} from "../agent-contract-store";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;

const sha = (letter: string) => letter.repeat(64);
const target = { origin: "https://claude.ai", path: "/plugins/exomem-hosted" };

function candidate() {
  const compatibility = {
    schema_version: 1, profile: EXOMEM_HOSTED_PROFILE, endpoint: "https://substratesystems.io/api/exomem/mcp/v1",
    source_release: "a".repeat(40), command_surface_sha256: sha("1"), schema_contract_sha256: sha("2"), compatibility_sha256: sha("3"),
    agent_contract: {
      protocol_version: "2025-03-26", agent_profile: { profile: EXOMEM_HOSTED_PROFILE, active_capability_sha256: sha("1") },
      digest: { algorithm: "sha256", value: sha("2") },
      commands: [{ name: "search", mcp_tool: { name: "search", description: "search", inputSchema: { type: "object" }, annotations: {} } }],
    },
  };
  const packageLock = { platform: "claude", endpoint: compatibility.endpoint, profile: compatibility.profile, command_surface_sha256: sha("1"), schema_contract_sha256: sha("2"), compatibility_sha256: sha("3"), artifact_sha256: sha("4"), plugin_version: "0.1.0" };
  return parseExomemAgentContractCandidate({ compatibility, packageLock, archiveLock: { platform: "claude", archive_sha256: sha("5") } });
}

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
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
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

  it("requires current matching Claude and OpenAI evidence before promoting the exact routable contract", async (t) => {
    const cell = await pool!.query<{ id: string }>("SELECT id FROM exomem_cells LIMIT 1");
    if (!cell.rows[0]) return t.skip("requires an existing test cell");
    const contract = candidate();
    const candidateId = await storeExomemAgentContractCandidate(contract);
    const observation = {
      cellId: cell.rows[0].id, sourceRelease: contract.sourceRelease, protocolVersion: contract.protocolVersion,
      commandSurfaceSha256: contract.commandSurfaceSha256, schemaDigest: contract.schemaDigest,
      compatibilitySha256: contract.compatibilitySha256,
    };

    await Promise.all([
      recordRoutableCellObservation({ ...observation, routable: true }),
      recordRoutableCellObservation({ ...observation, routable: false }),
    ]);
    await recordRoutableCellObservation({ ...observation, routable: true });
    const expectedDigest = createHash("sha256").update(`${observation.cellId}:${contract.schemaDigest}`).digest("hex");
    const authority = await pool!.query<{ routable_cell_count: number; routable_set_digest: string }>(
      "SELECT routable_cell_count, routable_set_digest FROM exomem_agent_contract_profile_authority WHERE profile_id = $1", [EXOMEM_HOSTED_PROFILE]
    );
    assert.deepEqual(authority.rows[0], { routable_cell_count: 1, routable_set_digest: expectedDigest });
    assert.equal(await promoteExomemAgentContractCandidate({ candidateId, expectedRoutableCellDigest: expectedDigest }), false, "missing evidence must not promote");

    const insertEvidence = async (platform: "claude" | "openai") => {
      await pool!.query(
        `INSERT INTO exomem_client_artifacts (platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256, plugin_version, client_identity, install_url, evidence_sha256, result_sha256, observed_at, promoted_at)
         VALUES ($1, 'live', $2, $3, $4, $5, $6, $7, 'https://claude.ai/plugins/exomem-hosted', $8, $9, now(), now())`,
        [platform, platform === "claude" ? sha("4") : sha("6"), platform === "claude" ? sha("5") : sha("7"), contract.compatibilitySha256, contract.schemaDigest, "0.1.0", `${platform}-${randomUUID()}`, sha("8"), sha("9")]
      );
    };
    await insertEvidence("claude");
    await insertEvidence("openai");
    assert.equal(await promoteExomemAgentContractCandidate({ candidateId, expectedRoutableCellDigest: expectedDigest }), true, "exact current evidence promotes");

    for (const platform of ["claude", "openai"] as const) {
      for (const [label, mutation] of [
        ["stale", "observed_at = now() - interval '25 hours'"],
        ["future", "observed_at = now() + interval '6 minutes'"],
        ["mismatched", `compatibility_sha256 = '${sha("a")}'`],
      ]) {
        const nextId = await storeExomemAgentContractCandidate(candidate());
        await pool!.query(`UPDATE exomem_client_artifacts SET ${mutation} WHERE platform = $1 AND state = 'live'`, [platform]);
        assert.equal(await promoteExomemAgentContractCandidate({ candidateId: nextId, expectedRoutableCellDigest: expectedDigest }), false, `${label} ${platform} evidence must not promote`);
        await pool!.query("UPDATE exomem_client_artifacts SET observed_at = now(), compatibility_sha256 = $1 WHERE platform = $2 AND state = 'live'", [contract.compatibilitySha256, platform]);
      }
    }
  });
});
