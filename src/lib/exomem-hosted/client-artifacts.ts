import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { exomemHostedContractFixture as exomemHostedContractFixture0340 } from "./agent-contract-fixture-0-34-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0350 } from "./agent-contract-fixture-0-35-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0392 } from "./agent-contract-fixture-0-39-2";
import { exomemHostedContractFixture as exomemHostedContractFixture0490 } from "./agent-contract-fixture-0-49-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0572 } from "./agent-contract-fixture";
import { exomemHostedContractFixture as exomemHostedContractFixture0500 } from "./agent-contract-fixture-0-50-0";
import { exomemHostedContractFixture as exomemHostedContractFixture0541 } from "./agent-contract-fixture-0-54-1";
import { executeExomemSql, type ExomemSql, withExomemTransaction } from "./db";

export type ClientArtifactState = "pending" | "live" | "failed" | "retired";
export type ClientArtifactPlatform = "claude" | "openai";
type Platform = ClientArtifactPlatform;
type ClientArtifact = {
  platform: Platform;
  state: ClientArtifactState;
  packageSha256: string;
  archiveSha256: string;
  compatibilitySha256: string;
  contractSha256: string;
  pluginVersion: string;
  clientIdentitySha256: string;
  pairedRunHmacSha256: string;
  exomemIdentityHmacSha256: string;
  tenantHmacSha256: string;
  installUrl: string;
  evidenceSha256: string;
  resultSha256: string;
  oauthClientConfigSha256: string;
  observedAt: string;
  candidateId: string;
  stagedClientReleaseId: string;
  assignmentId: string;
  assignmentGeneration: number;
};
export type PlatformLocks = {
  packageLock: Record<string, unknown>;
  archiveLock: Record<string, unknown>;
  candidateId: string | null;
  registeredAppIdSha256: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sha256 = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} must be SHA-256`);
  return value;
};

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

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid`);
  return parsed;
}

function trustedInstallTarget(platform: Platform): URL {
  const configured = process.env[`EXOMEM_HOSTED_${platform.toUpperCase()}_INSTALL_URL`];
  if (!configured) throw new Error("server-owned install target is not configured");
  const target = new URL(configured);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("server-owned install target is invalid");
  }
  return target;
}

/** Candidate URLs are checked against operator configuration, never a caller-supplied target. */
function parseClientArtifact(input: unknown): ClientArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("client artifact must be an object");
  const raw = input as Record<string, unknown>;
  if (raw.platform !== "claude" && raw.platform !== "openai")
    throw new Error("unsupported artifact platform");
  if (raw.state !== "pending") throw new Error("candidate artifacts must import as pending");
  const installUrl = new URL(String(raw.installUrl));
  const target = trustedInstallTarget(raw.platform);
  if (
    installUrl.href !== target.href ||
    /(?:token|tenant|cell|secret|localhost)/i.test(installUrl.toString())
  ) {
    throw new Error("install URL must be the configured tenant-neutral HTTPS target");
  }
  const observedAt = new Date(String(raw.observedAt));
  if (
    Number.isNaN(observedAt.valueOf()) ||
    observedAt.valueOf() > Date.now() + 5 * 60_000 ||
    observedAt.valueOf() < Date.now() - 24 * 60 * 60_000
  )
    throw new Error("observedAt is outside the evidence window");
  if (typeof raw.pluginVersion !== "string" || !raw.pluginVersion)
    throw new Error("pluginVersion must be non-empty");
  if ("clientIdentity" in raw)
    throw new Error("client identity must be supplied only as a privacy-safe hash");
  if (["registered_app_id", "registeredAppId", "app_id"].some((key) => key in raw))
    throw new Error("raw registered app IDs must never be persisted");
  if (typeof raw.candidateId !== "string" || !UUID.test(raw.candidateId))
    throw new Error("artifact contract candidate identity is invalid");
  return {
    platform: raw.platform,
    state: "pending",
    packageSha256: sha256(raw.packageSha256, "package digest"),
    archiveSha256: sha256(raw.archiveSha256, "archive digest"),
    compatibilitySha256: sha256(raw.compatibilitySha256, "compatibility digest"),
    contractSha256: sha256(raw.contractSha256, "contract digest"),
    pluginVersion: raw.pluginVersion,
    clientIdentitySha256: sha256(raw.clientIdentitySha256, "client identity digest"),
    pairedRunHmacSha256: sha256(raw.pairedRunHmacSha256, "paired run digest"),
    exomemIdentityHmacSha256: sha256(raw.exomemIdentityHmacSha256, "Exomem identity digest"),
    tenantHmacSha256: sha256(raw.tenantHmacSha256, "tenant digest"),
    installUrl: target.href,
    evidenceSha256: sha256(raw.evidenceSha256, "evidence digest"),
    resultSha256: sha256(raw.resultSha256, "result digest"),
    oauthClientConfigSha256: sha256(
      raw.oauthClientConfigSha256,
      "OAuth client configuration digest"
    ),
    observedAt: observedAt.toISOString(),
    candidateId: uuid(raw.candidateId, "artifact contract candidate identity"),
    stagedClientReleaseId: uuid(raw.stagedClientReleaseId, "staged client release identity"),
    assignmentId: uuid(raw.assignmentId, "rollout assignment identity"),
    assignmentGeneration: positiveInteger(
      raw.assignmentGeneration,
      "rollout assignment generation"
    ),
  };
}

const evidenceStrings = [
  "client_version",
  "clean_client_identity_hmac_sha256",
  "timestamp",
  "paired_run_hmac_sha256",
  "test_identity",
  "exomem_identity_hmac_sha256",
  "tenant_hmac_sha256",
  "entitlement_hmac_sha256",
  "provisioning_operation_hmac_sha256",
  "cell_hmac_sha256",
  "result_sha256",
  "package_artifact_sha256",
  "archive_sha256",
  "compatibility_sha256",
  "schema_contract_sha256",
  "command_surface_sha256",
  "endpoint",
  "plugin_version",
  "profile",
  "operator_key_id",
  "operator_signature",
  "oauth_client_config_sha256",
  "contract_candidate_id",
  "staged_client_release_id",
  "assignment_id",
  "assignment_generation",
] as const;
const evidenceCounts = [
  "identity_count",
  "tenant_count",
  "entitlement_count",
  "operation_count",
  "cell_count",
  "volume_count",
] as const;
const evidenceOperations = [
  "native_install",
  "authorization",
  "tool_discovery",
  "content_recall",
  "citation",
  "durable_capture",
  "fresh_chat_recall",
] as const;

export async function loadClientArtifactLocks(
  platform: Platform,
  candidateId: string,
  sql: ExomemSql = executeExomemSql
): Promise<PlatformLocks> {
  const { rows } = await sql`
    /* exomem:load-client-artifact-contract-locks */
    SELECT id::text AS candidate_id, source_release, claude_package_lock, claude_archive_lock,
           openai_package_lock, openai_archive_lock
    FROM exomem_agent_contract_candidates
    WHERE id = ${candidateId}::uuid AND profile_id = 'hosted-alpha-agent-v1'
      AND state IN ('pending', 'live')
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.candidate_id !== candidateId)
    throw new Error("artifact contract candidate is not pending or live");
  const fixture =
    row.source_release === "0.34.0"
      ? exomemHostedContractFixture0340
      : row.source_release === "0.35.0"
        ? exomemHostedContractFixture0350
        : row.source_release === "0.39.2"
          ? exomemHostedContractFixture0392
          : row.source_release === "0.49.0"
            ? exomemHostedContractFixture0490
            : row.source_release === "0.50.0"
              ? exomemHostedContractFixture0500
              : row.source_release === "0.54.1"
                ? exomemHostedContractFixture0541
                : row.source_release === "0.57.2"
                  ? exomemHostedContractFixture0572
                  : null;
  if (platform === "claude") {
    if (
      !fixture ||
      !row.claude_package_lock ||
      !row.claude_archive_lock ||
      canonical(row.claude_package_lock) !== canonical(fixture.packageLock) ||
      canonical(row.claude_archive_lock) !== canonical(fixture.archiveLock)
    ) {
      throw new Error("Claude locks differ from the checked Exomem release");
    }
    return {
      packageLock: fixture.packageLock,
      archiveLock: fixture.archiveLock,
      candidateId,
      registeredAppIdSha256: null,
    };
  }
  if (
    !row ||
    !row.openai_package_lock ||
    !row.openai_archive_lock ||
    typeof row.openai_package_lock !== "object" ||
    typeof row.openai_archive_lock !== "object" ||
    Array.isArray(row.openai_package_lock) ||
    Array.isArray(row.openai_archive_lock)
  ) {
    throw new Error("OpenAI package and archive locks are not yet operator-imported");
  }
  const packageLock = row.openai_package_lock as Record<string, unknown>;
  const archiveLock = row.openai_archive_lock as Record<string, unknown>;
  if (!fixture) throw new Error("OpenAI package lock differs from the checked release fixture");
  const fixtureLock: Record<string, unknown> = fixture.packageLock;
  const identityFields = [
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
  const packageKeys = [
    "platform",
    "artifact_sha256",
    "registered_app_id_sha256",
    ...identityFields,
  ];
  if (
    packageLock.platform !== "openai" ||
    typeof packageLock.artifact_sha256 !== "string" ||
    Object.keys(packageLock).length !== packageKeys.length ||
    Object.keys(packageLock).some((key) => !packageKeys.includes(key))
  ) {
    throw new Error("OpenAI package and archive locks are invalid");
  }
  if (identityFields.some((field) => packageLock[field] !== fixtureLock[field])) {
    throw new Error("OpenAI package lock differs from the checked release fixture");
  }
  const archiveKeys = ["platform", "archive_sha256", "registered_app_id_sha256"];
  if (
    archiveLock.platform !== "openai" ||
    typeof archiveLock.archive_sha256 !== "string" ||
    Object.keys(archiveLock).length !== archiveKeys.length ||
    Object.keys(archiveLock).some((key) => !archiveKeys.includes(key))
  ) {
    throw new Error("OpenAI archive lock is invalid");
  }
  sha256(packageLock.artifact_sha256, "OpenAI package digest");
  sha256(archiveLock.archive_sha256, "OpenAI archive digest");
  if (
    sha256(packageLock.registered_app_id_sha256, "OpenAI registered app ID digest") !==
    sha256(archiveLock.registered_app_id_sha256, "OpenAI registered app ID digest")
  ) {
    throw new Error("OpenAI package and archive locks have different registered app ID digests");
  }
  const registeredAppIdSha256 = sha256(
    packageLock.registered_app_id_sha256,
    "OpenAI registered app ID digest"
  );
  if (
    registeredAppIdSha256 !==
    sha256(archiveLock.registered_app_id_sha256, "OpenAI registered app ID digest")
  ) {
    throw new Error("OpenAI package and archive locks have different registered app ID digests");
  }
  return { packageLock, archiveLock, candidateId, registeredAppIdSha256 };
}

export function validatePromotionEvidence(
  input: unknown,
  platform: Platform,
  locks: PlatformLocks
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("promotion evidence must be an object");
  const evidence = input as Record<string, unknown>;
  const required = new Set([
    "schema_version",
    "platform",
    ...evidenceStrings,
    ...(platform === "openai" ? ["registered_app_id_sha256"] : []),
    ...evidenceCounts,
    ...evidenceOperations,
  ]);
  if (
    evidence.mocked ||
    Object.keys(evidence).length !== required.size ||
    Object.keys(evidence).some((key) => !required.has(key))
  ) {
    throw new Error("live promotion requires exact real content-bearing client evidence");
  }
  if (
    evidence.schema_version !== 1 ||
    evidence.platform !== platform ||
    ![
      ...evidenceStrings.filter((key) => key !== "assignment_generation"),
      ...(platform === "openai" ? ["registered_app_id_sha256"] : []),
    ].every((key) => typeof evidence[key] === "string" && evidence[key])
  ) {
    throw new Error("promotion evidence has invalid identity fields");
  }
  uuid(evidence.contract_candidate_id, "evidence candidate identity");
  uuid(evidence.staged_client_release_id, "evidence staged release identity");
  uuid(evidence.assignment_id, "evidence assignment identity");
  positiveInteger(evidence.assignment_generation, "evidence assignment generation");
  if (
    !evidenceCounts.every((key) => evidence[key] === 1) ||
    !evidenceOperations.every((key) => evidence[key] === true)
  ) {
    throw new Error("promotion evidence has invalid acceptance results");
  }
  if (
    evidence.test_identity !== "hosted-client-plugins-v1" ||
    evidence.endpoint !== locks.packageLock.endpoint ||
    evidence.profile !== locks.packageLock.profile ||
    evidence.plugin_version !== locks.packageLock.plugin_version ||
    evidence.compatibility_sha256 !== locks.packageLock.compatibility_sha256 ||
    evidence.schema_contract_sha256 !== locks.packageLock.schema_contract_sha256 ||
    evidence.command_surface_sha256 !== locks.packageLock.command_surface_sha256
  ) {
    throw new Error("promotion evidence differs from the checked release fixture");
  }
  if (
    evidence.package_artifact_sha256 !== locks.packageLock.artifact_sha256 ||
    evidence.archive_sha256 !== locks.archiveLock.archive_sha256 ||
    (platform === "openai" &&
      (evidence.registered_app_id_sha256 !== locks.packageLock.registered_app_id_sha256 ||
        evidence.registered_app_id_sha256 !== locks.archiveLock.registered_app_id_sha256))
  ) {
    throw new Error("promotion requires the exact registered package and archive locks");
  }
  const timestamp = new Date(String(evidence.timestamp));
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(evidence.timestamp)) ||
    Number.isNaN(timestamp.valueOf()) ||
    timestamp.valueOf() > Date.now() ||
    timestamp.valueOf() < Date.now() - 24 * 60 * 60_000
  ) {
    throw new Error("promotion evidence timestamp is stale");
  }
  for (const key of [
    "result_sha256",
    "package_artifact_sha256",
    "archive_sha256",
    ...(platform === "openai" ? ["registered_app_id_sha256"] : []),
    "compatibility_sha256",
    "schema_contract_sha256",
    "command_surface_sha256",
    "clean_client_identity_hmac_sha256",
    "paired_run_hmac_sha256",
    "exomem_identity_hmac_sha256",
    "tenant_hmac_sha256",
    "entitlement_hmac_sha256",
    "provisioning_operation_hmac_sha256",
    "cell_hmac_sha256",
    "oauth_client_config_sha256",
  ] as const)
    sha256(evidence[key], key);
  const keyId = process.env.EXOMEM_HOSTED_PROMOTION_KEY_ID;
  const secret = process.env.EXOMEM_HOSTED_PROMOTION_SECRET;
  if (!keyId || !secret || evidence.operator_key_id !== keyId)
    throw new Error("promotion requires an operator-trusted signing key");
  const unsigned = { ...evidence };
  delete unsigned.operator_signature;
  const expected = createHmac("sha256", secret).update(canonical(unsigned)).digest();
  const supplied = Buffer.from(String(evidence.operator_signature), "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error("artifact evidence signature is invalid");
  return evidence;
}

export function promotionEvidenceDigest(evidence: Record<string, unknown>): string {
  return createHash("sha256").update(canonical(evidence)).digest("hex");
}

export async function demoteClientArtifact(
  artifactId: string,
  reasonSha256: string
): Promise<boolean> {
  return withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows } = await transaction`
      /* exomem:demote-client-artifact */
      UPDATE exomem_client_artifacts SET state = 'failed', failed_at = now()
      WHERE id = ${artifactId}::uuid AND state = 'live' AND ${sha256(reasonSha256, "demotion reason")} IS NOT NULL RETURNING id
    `;
    return rows.length === 1;
  });
}

/** Persist only a server-validated pending artifact; no parsed-record bypass is exported. */
export async function storeClientArtifact(input: unknown): Promise<string> {
  const artifact = parseClientArtifact(input);
  const source = input as Record<string, unknown>;
  return withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    const locks = await loadClientArtifactLocks(
      artifact.platform,
      artifact.candidateId,
      transaction
    );
    const evidence = validatePromotionEvidence(source.evidence, artifact.platform, locks);
    const evidenceSha256 = promotionEvidenceDigest(evidence);
    if (
      artifact.evidenceSha256 !== evidenceSha256 ||
      artifact.resultSha256 !== evidence.result_sha256 ||
      artifact.packageSha256 !== evidence.package_artifact_sha256 ||
      artifact.archiveSha256 !== evidence.archive_sha256 ||
      artifact.compatibilitySha256 !== evidence.compatibility_sha256 ||
      artifact.contractSha256 !== evidence.schema_contract_sha256 ||
      artifact.pluginVersion !== evidence.plugin_version ||
      artifact.clientIdentitySha256 !== evidence.clean_client_identity_hmac_sha256 ||
      artifact.pairedRunHmacSha256 !== evidence.paired_run_hmac_sha256 ||
      artifact.exomemIdentityHmacSha256 !== evidence.exomem_identity_hmac_sha256 ||
      artifact.tenantHmacSha256 !== evidence.tenant_hmac_sha256 ||
      artifact.oauthClientConfigSha256 !== evidence.oauth_client_config_sha256 ||
      artifact.candidateId !== evidence.contract_candidate_id ||
      artifact.stagedClientReleaseId !== evidence.staged_client_release_id ||
      artifact.assignmentId !== evidence.assignment_id ||
      artifact.assignmentGeneration !== evidence.assignment_generation ||
      artifact.observedAt !== evidence.timestamp
    ) {
      throw new Error("artifact fields do not match signed evidence");
    }
    const { rows: stageRows } = await transaction`
      /* exomem:lock-staged-client-release-for-artifact */
      SELECT stage.id::text AS id, assignment.tenant_id::text AS tenant_id,
             assignment.id::text AS assignment_id, assignment.generation AS assignment_generation
      FROM exomem_staged_client_releases AS stage
      JOIN exomem_agent_contract_candidates AS candidate ON candidate.id = stage.candidate_id
      JOIN exomem_agent_contract_rollout_assignments AS assignment
        ON assignment.candidate_id = candidate.id
      WHERE candidate.id = ${artifact.candidateId}::uuid
        AND candidate.profile_id = 'hosted-alpha-agent-v1'
        AND candidate.state = 'pending'
        AND candidate.created_at < ${artifact.observedAt}::timestamptz
        AND stage.platform = ${artifact.platform} AND stage.state = 'staged'
        AND stage.id = ${artifact.stagedClientReleaseId}::uuid
        AND stage.expires_at > now() AND stage.created_at < ${artifact.observedAt}::timestamptz
        AND stage.package_sha256 = ${artifact.packageSha256}
        AND stage.archive_sha256 = ${artifact.archiveSha256}
        AND stage.compatibility_sha256 = ${artifact.compatibilitySha256}
        AND stage.contract_sha256 = ${artifact.contractSha256}
        AND stage.plugin_version = ${artifact.pluginVersion}
        AND stage.oauth_client_config_sha256 = ${artifact.oauthClientConfigSha256}
        AND stage.registered_app_id_sha256 IS NOT DISTINCT FROM ${locks.registeredAppIdSha256}
        AND assignment.id = ${artifact.assignmentId}::uuid
        AND assignment.generation = ${artifact.assignmentGeneration}::bigint
        AND assignment.marketplace_reviewer_purpose = true
        AND assignment.state = 'active' AND assignment.expires_at > now()
      LIMIT 2
      FOR UPDATE OF stage, candidate, assignment
    `;
    if (stageRows.length !== 1 || typeof stageRows[0]?.id !== "string")
      throw new Error("artifact stage precondition failed");
    const stageId = artifact.stagedClientReleaseId;
    const { rows } = await transaction`
      /* exomem:store-client-artifact */
      INSERT INTO exomem_client_artifacts (
        platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
        plugin_version, client_identity_sha256, paired_run_hmac_sha256, exomem_identity_hmac_sha256,
        tenant_hmac_sha256, install_url, evidence_sha256, result_sha256, contract_candidate_id,
        registered_app_id_sha256, oauth_client_config_sha256, observed_at, staged_client_release_id
      ) VALUES (
        ${artifact.platform}, ${artifact.state}, ${artifact.packageSha256}, ${artifact.archiveSha256},
        ${artifact.compatibilitySha256}, ${artifact.contractSha256}, ${artifact.pluginVersion},
        ${artifact.clientIdentitySha256}, ${artifact.pairedRunHmacSha256}, ${artifact.exomemIdentityHmacSha256},
        ${artifact.tenantHmacSha256}, ${artifact.installUrl}, ${artifact.evidenceSha256}, ${artifact.resultSha256},
        ${artifact.candidateId}::uuid, ${locks.registeredAppIdSha256}, ${artifact.oauthClientConfigSha256},
        ${artifact.observedAt}, ${stageId}::uuid
      ) RETURNING id
    `;
    const id = rows[0]?.id;
    if (typeof id !== "string") throw new Error("client artifact insert returned no id");
    const { rows: evidenced } = await transaction`
      /* exomem:evidence-staged-client-release */
      UPDATE exomem_staged_client_releases
      SET state = 'evidenced', evidenced_at = now(), version = version + 1, updated_at = now()
      WHERE id = ${stageId}::uuid AND state = 'staged'
      RETURNING id
    `;
    if (evidenced.length !== 1) throw new Error("artifact stage precondition failed");
    return id;
  });
}
