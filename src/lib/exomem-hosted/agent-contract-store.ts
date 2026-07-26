import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { executeExomemSql, executeExomemTransaction, withExomemTransaction } from "./db";
import { exomemHostedContractFixture } from "./agent-contract-fixture";

export const EXOMEM_HOSTED_PROFILE = "hosted-alpha-agent-v1";
export const EXOMEM_HOSTED_RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";
const TRUSTED_SOURCE_COMMIT = "08f1cee281bd0dbcaf82094421c11d6be04dc5c2";
const TRUSTED_RELEASE = {
  source_release: "0.33.0",
  command_surface_sha256: "eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f",
  schema_contract_sha256: "57ea9633fc1ccd6bb365ae8e70d42b29dc75e41e3e24b043e333b875a0c66dd3",
  compatibility_sha256: "aba2095396992240ce9c92ff0f66183362b3db97101442005549a8f8b026eb34",
  artifact_sha256: "b468f0425e7a021f3d7806991abdf6ae5724298fdd3cb6540cb68e1a4edb4c89",
  archive_sha256: "cdba2b1b1ca7f165915ff73a27f991228df13b0d6c67c2607f5c34fb4d563057",
} as const;
const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;

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
  mcpProtocolVersions: string[];
  tools: unknown[];
  compatibility: JsonRecord;
  claudePackageLock: JsonRecord;
  claudeArchiveLock: JsonRecord;
  openaiPackageLock: JsonRecord | null;
  openaiArchiveLock: JsonRecord | null;
};

export type LiveExomemAgentContract = {
  profile: typeof EXOMEM_HOSTED_PROFILE;
  endpoint: typeof EXOMEM_HOSTED_RESOURCE;
  sourceRelease: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
  protocolVersion: string;
  mcpProtocolVersions: string[];
  contract: JsonRecord;
};

type RoutableCellIdentity = {
  cell_id: unknown;
  source_release: unknown;
  protocol_version: unknown;
  command_fingerprint: unknown;
  contract_digest: unknown;
  compatibility_digest: unknown;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
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

function mcpProtocolVersions(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some((version) => typeof version !== "string" || !/^20\d\d-\d\d-\d\d$/.test(version)) ||
    new Set(value).size !== value.length
  )
    throw new Error("MCP protocol versions are invalid");
  return [...value] as string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkedOpenAiLocks(
  packageLock: unknown,
  archiveLock: unknown
): { packageLock: JsonRecord; archiveLock: JsonRecord } {
  const packageRecord = record(packageLock, "OpenAI package lock");
  const archiveRecord = record(archiveLock, "OpenAI archive lock");
  const claudeLock = record(exomemHostedContractFixture.packageLock, "Claude package lock");
  const expected = [
    "schema_version",
    "platform_schema_version",
    "plugin_id",
    "plugin_version",
    "endpoint",
    "profile",
    "command_surface_sha256",
    "schema_contract_sha256",
    "definition_sha256",
    "skills_sha256",
    "compatibility_sha256",
    "oauth_discovery_sha256",
  ];
  const packageKeys = ["platform", "artifact_sha256", "registered_app_id_sha256", ...expected];
  if (
    packageRecord.platform !== "openai" ||
    expected.some((key) => packageRecord[key] !== claudeLock[key]) ||
    Object.keys(packageRecord).length !== packageKeys.length ||
    Object.keys(packageRecord).some((key) => !packageKeys.includes(key))
  ) {
    throw new Error("OpenAI locks differ from the checked Exomem release");
  }
  const archiveKeys = ["platform", "archive_sha256", "registered_app_id_sha256"];
  if (
    archiveRecord.platform !== "openai" ||
    Object.keys(archiveRecord).length !== archiveKeys.length ||
    Object.keys(archiveRecord).some((key) => !archiveKeys.includes(key))
  ) {
    throw new Error("OpenAI archive lock is invalid");
  }
  sha256(packageRecord.artifact_sha256, "OpenAI package artifact digest");
  sha256(archiveRecord.archive_sha256, "OpenAI archive digest");
  if (
    sha256(packageRecord.registered_app_id_sha256, "OpenAI registered app ID digest") !==
    sha256(archiveRecord.registered_app_id_sha256, "OpenAI registered app ID digest")
  ) {
    throw new Error("OpenAI locks have different registered app ID digests");
  }
  return { packageLock: packageRecord, archiveLock: archiveRecord };
}

/** Import only the checked, pinned Exomem release fixture; callers cannot supply a contract. */
function checkedExomemAgentContractCandidate(): ExomemAgentContractCandidate {
  const source = record(exomemHostedContractFixture, "fixture");
  if (source.sourceCommit !== TRUSTED_SOURCE_COMMIT) {
    throw new Error("agent contract fixture has an untrusted source commit");
  }
  const compatibility = record(source.compatibility, "compatibility");
  const packageLock = record(source.packageLock, "Claude package lock");
  const archiveLock = record(source.archiveLock, "Claude archive lock");
  if (
    compatibility.source_release !== TRUSTED_RELEASE.source_release ||
    compatibility.command_surface_sha256 !== TRUSTED_RELEASE.command_surface_sha256 ||
    compatibility.schema_contract_sha256 !== TRUSTED_RELEASE.schema_contract_sha256 ||
    compatibility.compatibility_sha256 !== TRUSTED_RELEASE.compatibility_sha256 ||
    packageLock.artifact_sha256 !== TRUSTED_RELEASE.artifact_sha256 ||
    archiveLock.archive_sha256 !== TRUSTED_RELEASE.archive_sha256
  ) {
    throw new Error("agent contract fixture differs from the trusted Exomem release");
  }
  if (compatibility.schema_version !== 1) throw new Error("unsupported compatibility schema");
  if (
    compatibility.profile !== EXOMEM_HOSTED_PROFILE ||
    compatibility.endpoint !== EXOMEM_HOSTED_RESOURCE
  ) {
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
    if (
      typeof mcpTool.description !== "string" ||
      !record(mcpTool.inputSchema, "raw MCP input schema")
    ) {
      throw new Error("raw MCP tool is incomplete");
    }
    record(mcpTool.annotations, "raw MCP annotations");
    return mcpTool;
  });
  if (
    !tools?.length ||
    profile.profile !== EXOMEM_HOSTED_PROFILE ||
    agentContract.protocol_version !== "1"
  ) {
    throw new Error("agent profile has an unsupported protocol");
  }
  const commandSurfaceSha256 = sha256(
    compatibility.command_surface_sha256,
    "command surface digest"
  );
  const schemaDigest = sha256(compatibility.schema_contract_sha256, "schema digest");
  if (
    sha256(profile.active_capability_sha256, "agent profile digest") !== commandSurfaceSha256 ||
    sha256(digest.value, "agent contract digest") !== schemaDigest ||
    digest.algorithm !== "sha256"
  ) {
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
    state: "pending",
    profile: EXOMEM_HOSTED_PROFILE,
    endpoint: EXOMEM_HOSTED_RESOURCE,
    sourceRelease: string(compatibility.source_release, "source release"),
    commandSurfaceSha256,
    schemaDigest,
    compatibilitySha256: sha256(compatibility.compatibility_sha256, "compatibility digest"),
    protocolVersion: string(agentContract.protocol_version, "protocol version"),
    mcpProtocolVersions: [...MCP_PROTOCOL_VERSIONS],
    tools,
    compatibility,
    claudePackageLock: packageLock,
    claudeArchiveLock: archiveLock,
    // The checked release deliberately has no registered OpenAI package/archive lock.
    openaiPackageLock: null,
    openaiArchiveLock: null,
  };
}

/** Store the sole checked Exomem fixture; no caller-supplied contract is accepted. */
export async function storeExomemAgentContractCandidate(): Promise<string> {
  const candidate = checkedExomemAgentContractCandidate();
  const { rows } = await executeExomemSql`
    /* exomem:store-agent-contract-candidate */
    INSERT INTO exomem_agent_contract_candidates (
      state, profile_id, endpoint, source_release, command_fingerprint, schema_digest,
      compatibility_digest, protocol_version, mcp_protocol_versions, contract, claude_package_lock, claude_archive_lock,
      openai_package_lock, openai_archive_lock
    ) VALUES (
      'pending', ${candidate.profile}, ${candidate.endpoint}, ${candidate.sourceRelease},
      ${candidate.commandSurfaceSha256}, ${candidate.schemaDigest}, ${candidate.compatibilitySha256},
      ${candidate.protocolVersion}, ${JSON.stringify(candidate.mcpProtocolVersions)}::jsonb, ${JSON.stringify(candidate.compatibility)}::jsonb,
      ${JSON.stringify(candidate.claudePackageLock)}::jsonb, ${JSON.stringify(candidate.claudeArchiveLock)}::jsonb,
      ${candidate.openaiPackageLock === null ? null : JSON.stringify(candidate.openaiPackageLock)}::jsonb,
      ${candidate.openaiArchiveLock === null ? null : JSON.stringify(candidate.openaiArchiveLock)}::jsonb
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("agent contract candidate insert returned no id");
  return id;
}

/** Discovery reads one already-promoted contract; it never contacts or wakes a cell. */
export async function getLiveExomemAgentContract(): Promise<LiveExomemAgentContract | null> {
  const { rows } = await executeExomemSql`
    /* exomem:get-live-agent-contract */
    SELECT profile_id, endpoint, source_release, command_fingerprint, schema_digest,
           compatibility_digest, protocol_version, mcp_protocol_versions, contract
    FROM exomem_agent_contract_candidates
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
      AND endpoint = ${EXOMEM_HOSTED_RESOURCE}
      AND state = 'live'
    LIMIT 2
  `;
  if (rows.length !== 1) return null;
  const row = rows[0] as Record<string, unknown>;
  try {
    if (row.profile_id !== EXOMEM_HOSTED_PROFILE || row.endpoint !== EXOMEM_HOSTED_RESOURCE)
      return null;
    return {
      profile: EXOMEM_HOSTED_PROFILE,
      endpoint: EXOMEM_HOSTED_RESOURCE,
      sourceRelease: string(row.source_release, "live source release"),
      commandFingerprint: sha256(row.command_fingerprint, "live command fingerprint"),
      schemaDigest: sha256(row.schema_digest, "live schema digest"),
      compatibilityDigest: sha256(row.compatibility_digest, "live compatibility digest"),
      protocolVersion: string(row.protocol_version, "live protocol version"),
      mcpProtocolVersions: mcpProtocolVersions(row.mcp_protocol_versions),
      contract: record(row.contract, "live contract"),
    };
  } catch {
    return null;
  }
}

export type OperatorExomemAgentContractStatus = {
  id: string;
  state: "pending" | "live" | "retired";
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
};

/** Operator status exposes only candidate IDs and verification digests, never contract content. */
export async function listExomemAgentContractStatus(): Promise<
  OperatorExomemAgentContractStatus[]
> {
  const { rows } = await executeExomemSql`
    /* exomem:list-agent-contract-status */
    SELECT id, state, command_fingerprint, schema_digest, compatibility_digest
    FROM exomem_agent_contract_candidates
    WHERE profile_id = ${EXOMEM_HOSTED_PROFILE}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      (row.state !== "pending" && row.state !== "live" && row.state !== "retired") ||
      typeof row.command_fingerprint !== "string" ||
      typeof row.schema_digest !== "string" ||
      typeof row.compatibility_digest !== "string"
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        state: row.state,
        commandFingerprint: row.command_fingerprint,
        schemaDigest: row.schema_digest,
        compatibilityDigest: row.compatibility_digest,
      },
    ];
  });
}

/** A rollback retires the live candidate atomically; it never marks it as a failed import. */
export async function demoteExomemAgentContractCandidate(candidateId: string): Promise<boolean> {
  return withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await transaction`
      /* exomem:demote-agent-contract-candidate */
      UPDATE exomem_agent_contract_candidates
      SET state = 'retired', retired_at = now()
      WHERE id = ${candidateId}::uuid
        AND profile_id = ${EXOMEM_HOSTED_PROFILE}
        AND state = 'live'
      RETURNING id
    `;
    return rows.length === 1;
  });
}

/** Attach operator-signed, exact OpenAI locks after a registered app is rendered from this pinned release. */
export async function attachOpenAiContractLocks(input: {
  candidateId: string;
  packageLock: unknown;
  archiveLock: unknown;
  operatorKeyId: string;
  operatorSignature: string;
}): Promise<boolean> {
  const locks = checkedOpenAiLocks(input.packageLock, input.archiveLock);
  const keyId = process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID;
  const secret = process.env.EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET;
  const unsigned = {
    candidateId: input.candidateId,
    packageLock: locks.packageLock,
    archiveLock: locks.archiveLock,
    operatorKeyId: input.operatorKeyId,
  };
  if (!keyId || !secret || input.operatorKeyId !== keyId)
    throw new Error("OpenAI lock import requires an operator-trusted signing key");
  const expected = createHmac("sha256", secret).update(canonical(unsigned)).digest();
  const supplied = Buffer.from(input.operatorSignature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("OpenAI lock import signature is invalid");
  }
  const { rows } = await executeExomemSql`
    /* exomem:attach-openai-contract-locks */
    UPDATE exomem_agent_contract_candidates
    SET openai_package_lock = ${JSON.stringify(locks.packageLock)}::jsonb,
        openai_archive_lock = ${JSON.stringify(locks.archiveLock)}::jsonb
    WHERE id = ${input.candidateId}::uuid AND profile_id = ${EXOMEM_HOSTED_PROFILE} AND state = 'pending'
      AND openai_package_lock IS NULL AND openai_archive_lock IS NULL
    RETURNING id
  `;
  return rows.length === 1;
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
      [
        EXOMEM_HOSTED_PROFILE,
        input.sourceRelease,
        input.protocolVersion,
        fingerprint,
        contract,
        compatibility,
      ]
    );
    await transaction.query(
      `SELECT profile_id FROM exomem_agent_contract_profile_authority WHERE profile_id = $1 FOR UPDATE`,
      [EXOMEM_HOSTED_PROFILE]
    );
    await transaction.query(
      `INSERT INTO exomem_routable_cell_contracts (cell_id, profile_id, source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest, routable, observed_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (cell_id, profile_id) DO UPDATE SET source_release = EXCLUDED.source_release, protocol_version = EXCLUDED.protocol_version, command_fingerprint = EXCLUDED.command_fingerprint, contract_digest = EXCLUDED.contract_digest, compatibility_digest = EXCLUDED.compatibility_digest, routable = EXCLUDED.routable, observed_at = now()`,
      [
        input.cellId,
        EXOMEM_HOSTED_PROFILE,
        input.sourceRelease,
        input.protocolVersion,
        fingerprint,
        contract,
        compatibility,
        input.routable,
      ]
    );
    const cells = await transaction.query(
      `SELECT cell_id::text AS cell_id, source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest
       FROM exomem_routable_cell_contracts WHERE profile_id = $1 AND routable = true ORDER BY cell_id FOR UPDATE`,
      [EXOMEM_HOSTED_PROFILE]
    );
    const identities = cells.rows as RoutableCellIdentity[];
    const entries = identities.map((row) =>
      JSON.stringify([
        EXOMEM_HOSTED_PROFILE,
        String(row.cell_id),
        String(row.source_release),
        String(row.protocol_version),
        String(row.command_fingerprint),
        String(row.contract_digest),
        String(row.compatibility_digest),
      ])
    );
    const digest = entries.length
      ? createHash("sha256").update(entries.join(",")).digest("hex")
      : "0".repeat(64);
    const allMatch = identities.every(
      (row) =>
        row.source_release === input.sourceRelease &&
        row.protocol_version === input.protocolVersion &&
        row.command_fingerprint === fingerprint &&
        row.contract_digest === contract &&
        row.compatibility_digest === compatibility
    );
    await transaction.query(
      `UPDATE exomem_agent_contract_profile_authority SET
         routable_set_digest = $2, routable_cell_count = $3,
         source_release = CASE WHEN $9 THEN $4 ELSE source_release END,
         protocol_version = CASE WHEN $9 THEN $5 ELSE protocol_version END,
         command_fingerprint = CASE WHEN $9 THEN $6 ELSE command_fingerprint END,
         contract_digest = CASE WHEN $9 THEN $7 ELSE contract_digest END,
         compatibility_digest = CASE WHEN $9 THEN $8 ELSE compatibility_digest END,
         observed_at = now(), updated_at = now() WHERE profile_id = $1`,
      [
        EXOMEM_HOSTED_PROFILE,
        digest,
        entries.length,
        input.sourceRelease,
        input.protocolVersion,
        fingerprint,
        contract,
        compatibility,
        allMatch,
      ]
    );
  });
}

/** One statement locks the candidate, rechecks all authoritative routable cells, then swaps live state. */
export async function promoteExomemAgentContractCandidate(input: {
  candidateId: string;
  expectedRoutableCellDigest: string;
}): Promise<boolean> {
  const expected = sha256(input.expectedRoutableCellDigest, "routable cell digest");
  return withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await transaction`
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
      SELECT source_release, protocol_version, command_fingerprint, contract_digest, compatibility_digest
      FROM exomem_routable_cell_contracts
      WHERE profile_id = ${EXOMEM_HOSTED_PROFILE} AND routable = true
      FOR UPDATE
    ), exact_cells AS (
      SELECT 1 FROM candidate
      JOIN authority ON authority.profile_id = candidate.profile_id
      WHERE EXISTS (SELECT 1 FROM cells)
        AND candidate.mcp_protocol_versions IS NOT NULL
        AND exomem_mcp_protocol_versions_are_valid(candidate.mcp_protocol_versions)
        AND authority.routable_set_digest = ${expected}
        AND authority.observed_at > now() - interval '5 minutes'
        AND authority.source_release = candidate.source_release
        AND authority.protocol_version = candidate.protocol_version
        AND authority.command_fingerprint = candidate.command_fingerprint
        AND authority.contract_digest = candidate.schema_digest
        AND authority.compatibility_digest = candidate.compatibility_digest
        AND NOT EXISTS (
          SELECT 1 FROM cells
          WHERE source_release <> candidate.source_release
             OR protocol_version <> candidate.protocol_version
             OR command_fingerprint <> candidate.command_fingerprint
             OR contract_digest <> candidate.schema_digest
             OR compatibility_digest <> candidate.compatibility_digest
        )
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
          AND candidate.openai_package_lock->>'registered_app_id_sha256' IS NOT NULL
          AND candidate.openai_package_lock->>'registered_app_id_sha256' = candidate.openai_archive_lock->>'registered_app_id_sha256'
          AND openai.package_sha256 = candidate.openai_package_lock->>'artifact_sha256'
          AND openai.archive_sha256 = candidate.openai_archive_lock->>'archive_sha256'
          AND openai.plugin_version = candidate.openai_package_lock->>'plugin_version'
          AND openai.contract_candidate_id = candidate.id
          AND openai.registered_app_id_sha256 = candidate.openai_package_lock->>'registered_app_id_sha256'
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
  });
}
