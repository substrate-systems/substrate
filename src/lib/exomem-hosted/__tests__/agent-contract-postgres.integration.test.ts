import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { parseExomemAgentContractCandidate, promoteExomemAgentContractCandidate, storeExomemAgentContractCandidate } from "../agent-contract-store";
import { demoteClientArtifact, parseClientArtifact, promoteClientArtifact, storeClientArtifact } from "../client-artifacts";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
const sha = (letter: string) => letter.repeat(64);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sql(pool: Pool): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    const result = await pool.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

function evidence(platform: "claude" | "openai", secret: string, suffix: string): Record<string, unknown> {
  const fixture = exomemHostedContractFixture;
  const unsigned: Record<string, unknown> = {
    schema_version: 1, platform, client_version: "1.0.0", clean_client_identity_hmac_sha256: sha("1"), timestamp: new Date().toISOString(), paired_run_hmac_sha256: sha("2"),
    test_identity: "hosted-client-plugins-v1", exomem_identity_hmac_sha256: sha("3"), tenant_hmac_sha256: sha("4"), entitlement_hmac_sha256: sha("5"), provisioning_operation_hmac_sha256: sha("6"), cell_hmac_sha256: sha("7"),
    identity_count: 1, tenant_count: 1, entitlement_count: 1, operation_count: 1, cell_count: 1, volume_count: 1,
    result_sha256: createHash("sha256").update(suffix).digest("hex"), package_artifact_sha256: fixture.packageLock.artifact_sha256, archive_sha256: fixture.archiveLock.archive_sha256,
    compatibility_sha256: fixture.compatibility.compatibility_sha256, schema_contract_sha256: fixture.compatibility.schema_contract_sha256, command_surface_sha256: fixture.compatibility.command_surface_sha256,
    endpoint: fixture.compatibility.endpoint, plugin_version: fixture.packageLock.plugin_version, profile: fixture.compatibility.profile, operator_key_id: "integration-operator",
    native_install: true, authorization: true, tool_discovery: true, content_recall: true, citation: true, durable_capture: true, fresh_chat_recall: true,
  };
  return { ...unsigned, operator_signature: createHmac("sha256", secret).update(canonical(unsigned)).digest("hex") };
}

describe("agent contract PostgreSQL constraints", { skip: !databaseUrl }, () => {
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    await pool.query("SELECT 1");
    __setExomemSqlForTests(sql(pool));
    process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL = "https://claude.ai/plugins/exomem-hosted";
    process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID = "integration-operator";
    process.env.EXOMEM_HOSTED_PROMOTION_SECRET = "integration-secret";
  });

  after(async () => {
    __setExomemSqlForTests(null);
    delete process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL;
    delete process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID;
    delete process.env.EXOMEM_HOSTED_PROMOTION_SECRET;
    await pool?.end();
  });

  it("demotes a publicly promoted live artifact without violating historical timestamp invariants", async () => {
    const signed = evidence("claude", "integration-secret", randomUUID());
    const artifact = parseClientArtifact({
      platform: "claude", state: "pending", packageSha256: signed.package_artifact_sha256, archiveSha256: signed.archive_sha256,
      compatibilitySha256: signed.compatibility_sha256, contractSha256: signed.schema_contract_sha256, pluginVersion: signed.plugin_version,
      clientIdentitySha256: sha("f"), installUrl: process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL, evidenceSha256: createHash("sha256").update(canonical(signed)).digest("hex"), resultSha256: signed.result_sha256, observedAt: new Date().toISOString(),
    });
    const id = await storeClientArtifact(artifact);
    assert.equal(await promoteClientArtifact({ artifactId: id, platform: "claude", evidence: signed }), true);
    assert.equal(await demoteClientArtifact(id, sha("9")), true);
    const row = await pool!.query<{ state: string; promoted_at: Date; failed_at: Date }>("SELECT state, promoted_at, failed_at FROM exomem_client_artifacts WHERE id = $1", [id]);
    assert.equal(row.rows[0]?.state, "failed");
    assert.ok(row.rows[0]?.promoted_at);
    assert.ok(row.rows[0]?.failed_at);
  });

  it("fails contract promotion closed while the exact OpenAI package lock is absent", async () => {
    const candidateId = await storeExomemAgentContractCandidate(parseExomemAgentContractCandidate());
    assert.equal(await promoteExomemAgentContractCandidate({ candidateId, expectedRoutableCellDigest: sha("0") }), false);
  });
});
