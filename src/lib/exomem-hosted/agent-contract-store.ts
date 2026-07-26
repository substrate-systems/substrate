import { createHash } from "node:crypto";
import { executeExomemSql, executeExomemTransaction } from "./db";
import { exomemHostedContractFixture } from "./agent-contract-fixture";

export const EXOMEM_HOSTED_PROFILE = "hosted-alpha-agent-v1";
export const EXOMEM_HOSTED_RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";

type JsonRecord = Record<string, unknown>;
type ContractState = "pending" | "live" | "failed" | "retired";

type ExomemAgentContractCandidate = {
  state: ContractState;
  profile: typeof EXOMEM_HOSTED_PROFILE;
  endpoint: typeof EXOMEM_HOSTED_RESOURCE;
  sourceRelease: string;
  commandSurfaceSha256: string;
  schemaDigest: string;
  compatibilitySha256: string;
  protocolVersion: string;
  tools: unknown[];
  compatibility: JsonRecord;
  claudePackageLock: JsonRecord;
  claudeArchiveLock: JsonRecord;
  openaiPackageLock: JsonRecord | null;
  openaiArchiveLock: JsonRecord | null;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sha256(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label} must be SHA-256`);
  return candidate;
}

/** Import only the checked, pinned Exomem release fixture; callers cannot supply a contract. */
function checkedExomemAgentContractCandidate(): ExomemAgentContractCandidate {
  const source = record(exomemHostedContractFixture, "fixture");
  if (source.sourceCommit !== "23d4a5db2eabd318b0a1f2bf5e9b352bc9852660") {
    throw new Error("agent contract fixture has an untrusted source commit");
  }
  const compatibility = record(source.compatibility, "compatibility");
  const packageLock = record(source.packageLock, "Claude package lock");
  const archiveLock = record(source.archiveLock, "Claude archive lock");
  if (compatibility.schema_version !== 1) throw new Error("unsupported compatibility schema");
  if (compatibility.profile !== EXOMEM_HOSTED_PROFILE || compatibility.endpoint !== EXOMEM_HOSTED_RESOURCE) {
    throw new Error("compatibility identity is not the Hosted agent contract");
  }
  const agentContract = record(compatibility.agent_contract, "agent contract");
  const profile = record(agentContract.agent_profile, "agent profile");
  const digest = record(agentContract.digest, "agent contract digest");
  const tools = (agentContract.commands as unknown[] | undefined)?.map((command) => {
    const raw = record(command, "agent command");
    const mcpTool = record(raw.mcp_tool, "raw MCP tool");
    if (string(raw.name, "agent command name") !== string(mcpTool.name, "raw MCP tool name")) {
      throw new Error("raw MCP tool name differs from the imported command");
    }
    if (typeof mcpTool.description !== "string" || !record(mcpTool.inputSchema, "raw MCP input schema")) {
      throw new Error("raw MCP tool is incomplete");
    }
    record(mcpTool.annotations, "raw MCP annotations");
    return mcpTool;
  });
  if (!tools?.length || profile.profile !== EXOMEM_HOSTED_PROFILE || agentContract.protocol_version !== "1") {
    throw new Error("agent profile has an unsupported protocol");
  }
  const commandSurfaceSha256 = sha256(compatibility.command_surface_sha256, "command surface digest");
  const schemaDigest = sha256(compatibility.schema_contract_sha256, "schema digest");
  if (sha256(profile.active_capability_sha256, "agent profile digest") !== commandSurfaceSha256 ||
      sha256(digest.value, "agent contract digest") !== schemaDigest || digest.algorithm !== "sha256") {
    throw new Error("agent contract digests disagree");
  }
  for (const [key, expected] of Object.entries({
    endpoint: EXOMEM_HOSTED_RESOURCE,
    profile: EXOMEM_HOSTED_PROFILE,
    command_surface_sha256: commandSurfaceSha256,
    schema_contract_sha256: schemaDigest,
    compatibility_sha256: sha256(compatibility.compatibility_sha256, "compatibility digest"),
  })) {
    if (packageLock[key] !== expected) throw new Error(`package lock differs for ${key}`);
  }
  if (packageLock.platform !== archiveLock.platform || typeof packageLock.platform !== "string") {
    throw new Error("package and archive locks must name the same platform");
  }
  sha256(packageLock.artifact_sha256, "package artifact digest");
  sha256(archiveLock.archive_sha256, "archive digest");
  return {
    state: "pending", profile: EXOMEM_HOSTED_PROFILE, endpoint: EXOMEM_HOSTED_RESOURCE,
    sourceRelease: string(compatibility.source_release, "source release"), commandSurfaceSha256,
    schemaDigest, compatibilitySha256: sha256(compatibility.compatibility_sha256, "compatibility digest"),
    protocolVersion: string(agentContract.protocol_version, "protocol version"), tools,
    compatibility, claudePackageLock: packageLock, claudeArchiveLock: archiveLock,
    // The checked release deliberately has no registered OpenAI package/archive lock.
    openaiPackageLock: null, openaiArchiveLock: null,
  };
}

/** Store the sole checked Exomem fixture; no caller-supplied contract is accepted. */
export async function storeExomemAgentContractCandidate(): Promise<string> {
  const candidate = checkedExomemAgentContractCandidate();
  const { rows } = await executeExomemSql`
    /* exomem:store-agent-contract-candidate */
    INSERT INTO exomem_agent_contract_candidates (
      state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
      compatibility_digest, protocol_version, contract, claude_package_lock, claude_archive_lock,
      openai_package_lock, openai_archive_lock
    ) VALUES (
      'pending', ${candidate.profile}, ${candidate.endpoint}, ${candidate.sourceRelease},
      ${candidate.commandSurfaceSha256}, ${candidate.schemaDigest}, ${candidate.compatibilitySha256},
      ${candidate.protocolVersion}, ${JSON.stringify(candidate.compatibility)}::jsonb,
      ${JSON.stringify(candidate.claudePackageLock)}::jsonb, ${JSON.stringify(candidate.claudeArchiveLock)}::jsonb,
      ${candidate.openaiPackageLock === null ? null : JSON.stringify(candidate.openaiPackageLock)}::jsonb,
      ${candidate.openaiArchiveLock === null ? null : JSON.stringify(candidate.openaiArchiveLock)}::jsonb
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("agent contract candidate insert returned no id");
  return id;
}

/** The sole authority writer: one connection serializes the profile, cells, and exact digest. */
export async function recordRoutableCellObservation(input: {
  cellId: string;
  sourceRelease: string;
  protocolVersion: string;
  commandSurfaceSha256: string;
  schemaDigest: string;
  compatibilitySha256: string;
  routable: boolean;
}): Promise<void> {
  const fingerprint = sha256(input.commandSurfaceSha256, "command surface digest");
  const contract = sha256(input.schemaDigest, "schema digest");
  const compatibility = sha256(input.compatibilitySha256, "compatibility digest");
  await executeExomemTransaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO exomem_agent_contract_profile_authority (profile_id, routable_set_digest, routable_cell_count, source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest, observed_at)
       VALUES ($1, repeat('0', 64), 0, $2, $3, $4, $5, $6, now()) ON CONFLICT (profile_id) DO NOTHING`,
      [EXOMEM_HOSTED_PROFILE, input.sourceRelease, input.protocolVersion, fingerprint, contract, compatibility]
    );
    await transaction.query(`SELECT profile_id FROM exomem_agent_contract_profile_authority WHERE profile_id = $1 FOR UPDATE`, [EXOMEM_HOSTED_PROFILE]);
    await transaction.query(
      `INSERT INTO exomem_routable_cell_contracts (cell_id, profile_id, source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest, routable, observed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (cell_id, profile_id) DO UPDATE SET source_release = EXCLUDED.source_release, protocol_version = EXCLUDED.protocol_version, command_fingerprint = EXCLUDED.command_fingerprint, contract_digest = EXCLUDED.contract_digest, compatibility_digest = EXCLUDED.compatibility_digest, routable = EXCLUDED.routable, observed_at = now()`,
      [input.cellId, EXOMEM_HOSTED_PROFILE, input.sourceRelease, input.protocolVersion, fingerprint, contract, compatibility, input.routable]
    );
    const cells = await transaction.query(
      `SELECT cell_id::text AS cell_id, contract_digest FROM exomem_routable_cell_contracts WHERE profile_id = $1 AND routable = true ORDER BY cell_id FOR UPDATE`,
      [EXOMEM_HOSTED_PROFILE]
    );
    const entries = cells.rows.map((row) => `${String(row.cell_id)}:${String(row.contract_digest)}`);
    const digest = entries.length ? createHash("sha256").update(entries.join(",")).digest("hex") : "0".repeat(64);
    await transaction.query(
      `UPDATE exomem_agent_contract_profile_authority SET routable_set_digest = $2, routable_cell_count = $3, source_release = $4, protocol_version = $5, command_fingerprint = $6, contract_digest = $7, compatibility_digest = $8, observed_at = now(), updated_at = now() WHERE profile_id = $1`,
      [EXOMEM_HOSTED_PROFILE, digest, entries.length, input.sourceRelease, input.protocolVersion, fingerprint, contract, compatibility]
    );
  });
}

/** One statement locks the candidate, rechecks all authoritative routable cells, then swaps live state. */
export async function promoteExomemAgentContractCandidate(input: {
  candidateId: string;
  expectedRoutableCellDigest: string;
}): Promise<boolean> {
  const expected = sha256(input.expectedRoutableCellDigest, "routable cell digest");
  const { rows } = await executeExomemSql`
    /* exomem:promote-agent-contract-candidate */
    WITH authority AS (
      SELECT authority.*
      FROM exomem_agent_contract_profile_authority AS authority
      WHERE authority.profile_id = ${EXOMEM_HOSTED_PROFILE}
      FOR UPDATE
    ), candidate AS (
      SELECT * FROM exomem_agent_contract_candidates
      WHERE id = ${input.candidateId}::uuid AND state = 'pending'
      FOR UPDATE
    ), cells AS (
      SELECT contract_digest
      FROM exomem_routable_cell_contracts
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND routable = true
      FOR UPDATE
    ), exact_cells AS (
      SELECT 1 FROM candidate
      JOIN authority ON authority.profile_id = candidate.profile_id
      WHERE EXISTS (SELECT 1 FROM cells)
        AND authority.routable_set_digest = ${expected}
        AND authority.observed_at > now() - interval '5 minutes'
        AND authority.source_release = candidate.source_release
        AND authority.protocol_version = candidate.protocol_version
        AND authority.command_fingerprint = candidate.command_fingerprint
        AND authority.contract_digest = candidate.schema_digest
        AND authority.compatibility_digest = candidate.compatibility_digest
        AND NOT EXISTS (SELECT 1 FROM cells WHERE contract_digest <> candidate.schema_digest)
    ), artifact_rows AS (
      SELECT * FROM exomem_client_artifacts
      WHERE platform IN ('claude', 'openai') AND state = 'live'
      FOR UPDATE
    ), evidence AS (
      SELECT 1 FROM candidate
      WHERE EXISTS (
        SELECT 1 FROM artifact_rows AS claude
        WHERE claude.platform = 'claude' AND claude.state = 'live'
          AND claude.compatibility_sha256 = candidate.compatibility_digest
          AND claude.contract_sha256 = candidate.schema_digest
          AND claude.package_sha256 = candidate.claude_package_lock->>'artifact_sha256'
          AND claude.archive_sha256 = candidate.claude_archive_lock->>'archive_sha256'
          AND claude.observed_at <= now() AND claude.observed_at > now() - interval '24 hours'
      ) AND EXISTS (
        SELECT 1 FROM artifact_rows AS openai
        WHERE openai.platform = 'openai' AND openai.state = 'live'
          AND openai.compatibility_sha256 = candidate.compatibility_digest
          AND openai.contract_sha256 = candidate.schema_digest
          -- The checked release currently has no registered OpenAI package/archive lock.
          -- Until one is imported into the candidate, promotion must fail closed.
          AND candidate.openai_package_lock->>'platform' = 'openai'
          AND openai.package_sha256 = candidate.openai_package_lock->>'artifact_sha256'
          AND openai.archive_sha256 = candidate.openai_archive_lock->>'archive_sha256'
          AND openai.plugin_version = candidate.openai_package_lock->>'plugin_version'
          AND EXISTS (
            SELECT 1 FROM artifact_rows AS claude_pair
            WHERE claude_pair.platform = 'claude'
              AND claude_pair.paired_run_hmac_sha256 = openai.paired_run_hmac_sha256
              AND claude_pair.exomem_identity_hmac_sha256 = openai.exomem_identity_hmac_sha256
              AND claude_pair.tenant_hmac_sha256 = openai.tenant_hmac_sha256
          )
          AND openai.observed_at <= now() AND openai.observed_at > now() - interval '24 hours'
      )
    ), retired AS (
      UPDATE exomem_agent_contract_candidates SET state = 'retired', retired_at = now()
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND state = 'live'
        AND EXISTS (SELECT 1 FROM exact_cells) AND EXISTS (SELECT 1 FROM evidence)
      RETURNING id
    ), retirement_complete AS (
      SELECT count(*) AS count FROM retired
    ), promoted AS (
      UPDATE exomem_agent_contract_candidates SET state = 'live', promoted_at = now()
      FROM retirement_complete
      WHERE id = ${input.candidateId}::uuid AND EXISTS (SELECT 1 FROM exact_cells)
        AND EXISTS (SELECT 1 FROM evidence)
      RETURNING id
    ) SELECT id FROM promoted
  `;
  return rows.length === 1;
}
