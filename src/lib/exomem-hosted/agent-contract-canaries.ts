import { executeExomemSql, type ExomemSql, withExomemTransaction } from "./db";
import { exomemContractFixture0340 } from "./gateway-contract-0-34-0";
import { exomemContractFixture0350 } from "./gateway-contract-0-35-0";

type AssignmentState = "preparing" | "active" | "failed" | "expired" | "retired";
type StageState = "staged" | "evidenced" | "failed" | "expired" | "retired";
type Platform = "claude" | "openai";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EXPIRY_MS = 7 * 24 * 60 * 60_000;

const gatewayContractDigests = new Map([
  [
    `${exomemContractFixture0340.release}:${exomemContractFixture0340.protocol}`,
    exomemContractFixture0340.digest,
  ],
  [
    `${exomemContractFixture0350.release}:${exomemContractFixture0350.protocol}`,
    exomemContractFixture0350.digest,
  ],
]);

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function uuid(value: string, label: string): string {
  if (!UUID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedExpiry(value: Date): string {
  const millis = value.valueOf();
  if (!Number.isFinite(millis) || millis <= Date.now() || millis > Date.now() + MAX_EXPIRY_MS)
    throw new Error("canary expiry is outside the bounded window");
  return value.toISOString();
}

function integer(value: unknown, label: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} is invalid`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function assignmentFromRow(row: Record<string, unknown>): ResolvedCanaryAssignment | null {
  try {
    if (
      typeof row.id !== "string" ||
      typeof row.tenant_id !== "string" ||
      typeof row.candidate_id !== "string" ||
      typeof row.source_release !== "string" ||
      typeof row.protocol_version !== "string" ||
      row.expires_at === undefined
    )
      return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      candidateId: row.candidate_id,
      generation: integer(row.generation, "assignment generation"),
      sourceRelease: row.source_release,
      protocolVersion: row.protocol_version,
      commandFingerprint: sha256(row.command_fingerprint, "assignment command fingerprint"),
      schemaDigest: sha256(row.schema_digest, "assignment schema digest"),
      compatibilityDigest: sha256(row.compatibility_digest, "assignment compatibility digest"),
      gatewayContractDigest: sha256(row.gateway_contract_digest, "assignment gateway digest"),
      expiresAt: timestamp(row.expires_at, "assignment expiry"),
    };
  } catch {
    return null;
  }
}

async function withCohortLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    return work(tx);
  });
}

export type CanaryOAuthLineage = {
  tenantId: string;
  candidateId: string;
  assignmentId: string;
  assignmentGeneration: number;
  stagedClientReleaseId: string;
  revokedByPrincipalDigest?: Buffer;
};

function validatedCanaryOAuthLineage(input: CanaryOAuthLineage): CanaryOAuthLineage {
  return {
    tenantId: uuid(input.tenantId, "tenant ID"),
    candidateId: uuid(input.candidateId, "candidate ID"),
    assignmentId: uuid(input.assignmentId, "assignment ID"),
    assignmentGeneration: integer(input.assignmentGeneration, "assignment generation"),
    stagedClientReleaseId: uuid(input.stagedClientReleaseId, "staged client release ID"),
  };
}

/** Caller holds the cohort lock; only internal-canary descendants may be terminated. */
export async function revokeCanaryOAuthLineageInTransaction(
  tx: ExomemSql,
  input: CanaryOAuthLineage
): Promise<number> {
  const lineage = validatedCanaryOAuthLineage(input);
  const { rows } = await tx`
    /* exomem:revoke-canary-oauth-lineage */
    WITH credentials AS (
      SELECT credential.id
      FROM exomem_marketplace_reviewer_credentials AS credential
      WHERE credential.tenant_id = ${lineage.tenantId}::uuid
        AND credential.credential_kind = 'internal_canary'
        AND credential.candidate_id = ${lineage.candidateId}::uuid
        AND credential.assignment_id = ${lineage.assignmentId}::uuid
        AND credential.assignment_generation = ${lineage.assignmentGeneration}::bigint
        AND credential.staged_client_release_id = ${lineage.stagedClientReleaseId}::uuid
        AND credential.revoked_at IS NULL
      FOR UPDATE
    ), revoked_credentials AS (
      UPDATE exomem_marketplace_reviewer_credentials AS credential
      SET revoked_at = now(),
          revoked_by_principal_digest = COALESCE(
            ${input.revokedByPrincipalDigest ?? null}, credential.revoked_by_principal_digest
          )
      WHERE credential.id IN (SELECT id FROM credentials)
      RETURNING credential.id
    ), sessions_revoked AS (
      UPDATE exomem_sessions AS session
      SET revoked_at = COALESCE(session.revoked_at, now())
      WHERE session.reviewer_credential_id IN (SELECT id FROM revoked_credentials)
        AND session.revoked_at IS NULL
      RETURNING session.id
    ), transactions_revoked AS (
      UPDATE exomem_oauth_authorization_transactions AS transaction
      SET consumed_at = COALESCE(transaction.consumed_at, now())
      WHERE transaction.reviewer_credential_id IN (SELECT id FROM revoked_credentials)
         OR transaction.redeemed_session_id IN (SELECT id FROM sessions_revoked)
      RETURNING transaction.id
    ), grants_revoked AS (
      UPDATE exomem_oauth_grants AS grant_row
      SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
      WHERE grant_row.reviewer_credential_id IN (SELECT id FROM revoked_credentials)
         OR grant_row.authorization_transaction_id IN (SELECT id FROM transactions_revoked)
      RETURNING grant_row.id
    ), codes_consumed AS (
      UPDATE exomem_oauth_authorization_codes AS code
      SET consumed_at = COALESCE(code.consumed_at, now())
      WHERE code.grant_id IN (SELECT id FROM grants_revoked)
        AND code.consumed_at IS NULL
      RETURNING code.id
    ), families_revoked AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = COALESCE(family.revoked_at, now()),
          revoked_reason = COALESCE(family.revoked_reason, 'canary_authority_revoked')
      WHERE family.grant_id IN (SELECT id FROM grants_revoked)
        AND family.revoked_at IS NULL
      RETURNING family.id
    ), refresh_consumed AS (
      UPDATE exomem_oauth_refresh_tokens AS token
      SET consumed_at = COALESCE(token.consumed_at, now())
      WHERE token.family_id IN (SELECT id FROM families_revoked)
        AND token.consumed_at IS NULL
      RETURNING token.id
    ), access_revoked AS (
      UPDATE exomem_oauth_access_tokens AS token
      SET revoked_at = COALESCE(token.revoked_at, now())
      WHERE token.grant_id IN (SELECT id FROM grants_revoked)
         OR token.family_id IN (SELECT id FROM families_revoked)
      RETURNING token.id
    )
    SELECT count(*)::integer AS revoked_credentials FROM revoked_credentials
  `;
  return Number(rows[0]?.revoked_credentials ?? 0);
}

/** Caller holds the cohort lock; retain only the exact lineage becoming active. */
export async function revokeConflictingCanaryOAuthLineageInTransaction(
  tx: ExomemSql,
  input: CanaryOAuthLineage
): Promise<number> {
  const lineage = validatedCanaryOAuthLineage(input);
  const { rows } = await tx`
    /* exomem:revoke-conflicting-canary-oauth-lineage */
    WITH conflicting_credentials AS (
      SELECT credential.id
      FROM exomem_marketplace_reviewer_credentials AS credential
      WHERE credential.tenant_id = ${lineage.tenantId}::uuid
        AND credential.credential_kind = 'internal_canary'
        AND credential.revoked_at IS NULL
        AND (
          credential.candidate_id IS DISTINCT FROM ${lineage.candidateId}::uuid
          OR credential.assignment_id IS DISTINCT FROM ${lineage.assignmentId}::uuid
          OR credential.assignment_generation IS DISTINCT FROM ${lineage.assignmentGeneration}::bigint
          OR credential.staged_client_release_id IS DISTINCT FROM ${lineage.stagedClientReleaseId}::uuid
        )
      FOR UPDATE
    ), revoked_credentials AS (
      UPDATE exomem_marketplace_reviewer_credentials AS credential
      SET revoked_at = now()
      WHERE credential.id IN (SELECT id FROM conflicting_credentials)
      RETURNING credential.id
    ), sessions_revoked AS (
      UPDATE exomem_sessions AS session
      SET revoked_at = COALESCE(session.revoked_at, now())
      WHERE session.reviewer_credential_id IN (SELECT id FROM revoked_credentials)
        AND session.revoked_at IS NULL
      RETURNING session.id
    ), transactions_revoked AS (
      UPDATE exomem_oauth_authorization_transactions AS transaction
      SET consumed_at = COALESCE(transaction.consumed_at, now())
      WHERE transaction.reviewer_credential_id IN (SELECT id FROM conflicting_credentials)
         OR transaction.redeemed_session_id IN (SELECT id FROM sessions_revoked)
      RETURNING transaction.id
    ), grants_revoked AS (
      UPDATE exomem_oauth_grants AS grant_row
      SET revoked_at = COALESCE(grant_row.revoked_at, now()), updated_at = now()
      WHERE grant_row.reviewer_credential_id IN (SELECT id FROM conflicting_credentials)
         OR grant_row.authorization_transaction_id IN (SELECT id FROM transactions_revoked)
      RETURNING grant_row.id
    ), codes_consumed AS (
      UPDATE exomem_oauth_authorization_codes AS code
      SET consumed_at = COALESCE(code.consumed_at, now())
      WHERE code.grant_id IN (SELECT id FROM grants_revoked)
        AND code.consumed_at IS NULL
      RETURNING code.id
    ), families_revoked AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = COALESCE(family.revoked_at, now()),
          revoked_reason = COALESCE(family.revoked_reason, 'canary_authority_replaced')
      WHERE family.grant_id IN (SELECT id FROM grants_revoked)
        AND family.revoked_at IS NULL
      RETURNING family.id
    ), refresh_consumed AS (
      UPDATE exomem_oauth_refresh_tokens AS token
      SET consumed_at = COALESCE(token.consumed_at, now())
      WHERE token.family_id IN (SELECT id FROM families_revoked)
        AND token.consumed_at IS NULL
      RETURNING token.id
    ), access_revoked AS (
      UPDATE exomem_oauth_access_tokens AS token
      SET revoked_at = COALESCE(token.revoked_at, now())
      WHERE token.grant_id IN (SELECT id FROM grants_revoked)
         OR token.family_id IN (SELECT id FROM families_revoked)
      RETURNING token.id
    )
    SELECT count(*)::integer AS revoked_credentials FROM revoked_credentials
  `;
  return Number(rows[0]?.revoked_credentials ?? 0);
}

export type CreatedCanaryAssignment = {
  id: string;
  generation: number;
  version: number;
  state: "preparing";
  expiresAt: string;
};

export type ResolvedCanaryAssignment = {
  id: string;
  tenantId: string;
  candidateId: string;
  generation: number;
  sourceRelease: string;
  protocolVersion: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
  gatewayContractDigest: string;
  expiresAt: string;
};

/** Creates a new immutable tenant generation; the target cannot be retargeted in place. */
export async function createCanaryAssignment(input: {
  tenantId: string;
  candidateId: string;
  expiresAt: Date;
  operatorPrincipalDigest: string;
}): Promise<CreatedCanaryAssignment> {
  const expiresAt = boundedExpiry(input.expiresAt);
  const tenantId = uuid(input.tenantId, "tenant ID");
  const candidateId = uuid(input.candidateId, "candidate ID");
  const operatorPrincipalDigest = sha256(
    input.operatorPrincipalDigest,
    "operator principal digest"
  );
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:create-canary-assignment */
      WITH candidate AS (
        SELECT candidate.id, candidate.source_release, candidate.protocol_version,
               candidate.command_fingerprint, candidate.schema_digest, candidate.compatibility_digest
        FROM exomem_agent_contract_candidates AS candidate
        WHERE candidate.id = ${candidateId}::uuid
          AND candidate.profile_id = 'hosted-alpha-agent-v1'
          AND candidate.state = 'pending'
        FOR UPDATE
      ), tenant AS (
        SELECT tenant.id, tenant.marketplace_reviewer_purpose
        FROM exomem_tenants AS tenant
        WHERE tenant.id = ${tenantId}::uuid AND tenant.deleted_at IS NULL
        FOR UPDATE
      ), prior AS (
        SELECT COALESCE((
          SELECT assignment.generation
          FROM exomem_agent_contract_rollout_assignments AS assignment
          JOIN tenant ON tenant.id = assignment.tenant_id
          ORDER BY assignment.generation DESC
          LIMIT 1
          FOR UPDATE
        ), 0) AS generation
      ), inserted AS (
        INSERT INTO exomem_agent_contract_rollout_assignments (
          tenant_id, candidate_id, generation, state, source_release, protocol_version,
          command_fingerprint, schema_digest, compatibility_digest, gateway_contract_digest,
          marketplace_reviewer_purpose, created_by_principal_digest, expires_at
        )
        SELECT tenant.id, candidate.id, prior.generation + 1, 'preparing', candidate.source_release,
               candidate.protocol_version, candidate.command_fingerprint, candidate.schema_digest,
               candidate.compatibility_digest,
               CASE candidate.source_release || ':' || candidate.protocol_version
                 WHEN ${exomemContractFixture0340.release + ":" + exomemContractFixture0340.protocol}
                   THEN ${gatewayContractDigests.get(exomemContractFixture0340.release + ":" + exomemContractFixture0340.protocol)}
                 WHEN ${exomemContractFixture0350.release + ":" + exomemContractFixture0350.protocol}
                   THEN ${gatewayContractDigests.get(exomemContractFixture0350.release + ":" + exomemContractFixture0350.protocol)}
                 ELSE NULL
               END,
               tenant.marketplace_reviewer_purpose, ${operatorPrincipalDigest}, ${expiresAt}::timestamptz
        FROM candidate CROSS JOIN tenant CROSS JOIN prior
        WHERE NOT EXISTS (
          SELECT 1 FROM exomem_agent_contract_rollout_assignments AS current
          WHERE current.tenant_id = tenant.id AND current.state IN ('preparing', 'active')
        )
        RETURNING id::text AS id, generation, version, state, expires_at
      ) SELECT * FROM inserted
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      typeof row.id !== "string" ||
      row.state !== "preparing" ||
      row.expires_at === undefined
    )
      throw new Error("canary assignment precondition failed");
    return {
      id: row.id,
      generation: integer(row.generation, "assignment generation"),
      version: integer(row.version, "assignment version"),
      state: "preparing",
      expiresAt: timestamp(row.expires_at, "assignment expiry"),
    };
  });
}

/** Routing must use an authenticated tenant ID; there is no public selector path. */
export async function resolveActiveCanaryAssignment(
  tenantId: string,
  sql: ExomemSql = executeExomemSql
): Promise<ResolvedCanaryAssignment | null> {
  const { rows } = await sql`
    /* exomem:resolve-active-canary-assignment */
    SELECT id::text AS id, tenant_id::text AS tenant_id, candidate_id::text AS candidate_id, generation,
           source_release, protocol_version, command_fingerprint, schema_digest, compatibility_digest,
           gateway_contract_digest, expires_at
    FROM exomem_agent_contract_rollout_assignments
    WHERE tenant_id = ${uuid(tenantId, "tenant ID")}::uuid AND state = 'active' AND expires_at > now()
    ORDER BY generation DESC
    LIMIT 2
  `;
  return rows.length === 1 ? assignmentFromRow(rows[0]!) : null;
}

/** Pending client authority is restricted to the immutable reviewer-purpose copy. */
export async function resolveReviewerCanaryAuthority(input: {
  tenantId: string;
  candidateId: string;
}): Promise<ResolvedCanaryAssignment | null> {
  const { rows } = await executeExomemSql`
    /* exomem:resolve-reviewer-canary-authority */
    SELECT id::text AS id, tenant_id::text AS tenant_id, candidate_id::text AS candidate_id, generation,
           source_release, protocol_version, command_fingerprint, schema_digest, compatibility_digest,
           gateway_contract_digest, expires_at
    FROM exomem_agent_contract_rollout_assignments
    WHERE tenant_id = ${uuid(input.tenantId, "tenant ID")}::uuid
      AND candidate_id = ${uuid(input.candidateId, "candidate ID")}::uuid
      AND marketplace_reviewer_purpose = true AND state = 'active' AND expires_at > now()
    ORDER BY generation DESC
    LIMIT 2
  `;
  return rows.length === 1 ? assignmentFromRow(rows[0]!) : null;
}

export type CreatedStagedClientRelease = { id: string; version: number; state: "staged" };

export type StagedClientRelease = {
  id: string;
  candidateId: string;
  platform: Platform;
  packageSha256: string;
  archiveSha256: string;
  compatibilitySha256: string;
  contractSha256: string;
  pluginVersion: string;
  oauthClientConfigSha256: string;
  registeredAppIdSha256: string | null;
  expiresAt: string;
  state: "staged" | "evidenced";
};

export async function createStagedClientRelease(input: {
  candidateId: string;
  platform: Platform;
  packageSha256: string;
  archiveSha256: string;
  compatibilitySha256: string;
  contractSha256: string;
  pluginVersion: string;
  oauthClientConfigSha256: string;
  registeredAppIdSha256: string | null;
  operatorPrincipalDigest: string;
  expiresAt: Date;
}): Promise<CreatedStagedClientRelease> {
  if (input.platform !== "claude" && input.platform !== "openai")
    throw new Error("platform is invalid");
  if (!input.pluginVersion) throw new Error("plugin version is invalid");
  if ((input.platform === "openai") !== (input.registeredAppIdSha256 !== null))
    throw new Error("registered app identity is invalid");
  const expiresAt = boundedExpiry(input.expiresAt);
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:create-staged-client-release */
      INSERT INTO exomem_staged_client_releases (
        candidate_id, platform, state, package_sha256, archive_sha256, compatibility_sha256,
        contract_sha256, plugin_version, oauth_client_config_sha256, registered_app_id_sha256,
        created_by_principal_digest, expires_at
      )
      SELECT candidate.id, ${input.platform}, 'staged', ${sha256(input.packageSha256, "package digest")},
             ${sha256(input.archiveSha256, "archive digest")},
             ${sha256(input.compatibilitySha256, "compatibility digest")},
             ${sha256(input.contractSha256, "contract digest")}, ${input.pluginVersion},
             ${sha256(input.oauthClientConfigSha256, "OAuth client configuration digest")},
             ${input.registeredAppIdSha256 === null ? null : sha256(input.registeredAppIdSha256, "registered app digest")},
             ${sha256(input.operatorPrincipalDigest, "operator principal digest")}, ${expiresAt}::timestamptz
      FROM exomem_agent_contract_candidates AS candidate
      WHERE candidate.id = ${uuid(input.candidateId, "candidate ID")}::uuid
        AND candidate.profile_id = 'hosted-alpha-agent-v1' AND candidate.state = 'pending'
        AND candidate.compatibility_digest = ${sha256(input.compatibilitySha256, "compatibility digest")}
        AND candidate.schema_digest = ${sha256(input.contractSha256, "contract digest")}
        AND ((${input.platform} = 'claude' AND candidate.claude_package_lock->>'artifact_sha256' = ${sha256(input.packageSha256, "package digest")}
              AND candidate.claude_archive_lock->>'archive_sha256' = ${sha256(input.archiveSha256, "archive digest")}
              AND candidate.claude_package_lock->>'plugin_version' = ${input.pluginVersion})
          OR (${input.platform} = 'openai' AND candidate.openai_package_lock->>'artifact_sha256' = ${sha256(input.packageSha256, "package digest")}
              AND candidate.openai_archive_lock->>'archive_sha256' = ${sha256(input.archiveSha256, "archive digest")}
              AND candidate.openai_package_lock->>'plugin_version' = ${input.pluginVersion}
              AND candidate.openai_package_lock->>'registered_app_id_sha256' = ${input.registeredAppIdSha256}))
      RETURNING id::text AS id, version, state
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row || typeof row.id !== "string" || row.state !== "staged")
      throw new Error("staged client release precondition failed");
    return { id: row.id, version: integer(row.version, "stage version"), state: "staged" };
  });
}

function stagedReleaseFromRow(row: Record<string, unknown>): StagedClientRelease | null {
  try {
    if (
      typeof row.id !== "string" ||
      typeof row.candidate_id !== "string" ||
      (row.platform !== "claude" && row.platform !== "openai") ||
      (row.state !== "staged" && row.state !== "evidenced") ||
      typeof row.plugin_version !== "string" ||
      row.expires_at === undefined ||
      (row.registered_app_id_sha256 !== null && typeof row.registered_app_id_sha256 !== "string")
    )
      return null;
    return {
      id: row.id,
      candidateId: row.candidate_id,
      platform: row.platform,
      packageSha256: sha256(row.package_sha256, "stage package digest"),
      archiveSha256: sha256(row.archive_sha256, "stage archive digest"),
      compatibilitySha256: sha256(row.compatibility_sha256, "stage compatibility digest"),
      contractSha256: sha256(row.contract_sha256, "stage contract digest"),
      pluginVersion: row.plugin_version,
      oauthClientConfigSha256: sha256(row.oauth_client_config_sha256, "stage OAuth digest"),
      registeredAppIdSha256:
        row.registered_app_id_sha256 === null
          ? null
          : sha256(row.registered_app_id_sha256, "stage app digest"),
      expiresAt: timestamp(row.expires_at, "stage expiry"),
      state: row.state,
    };
  } catch {
    return null;
  }
}

export async function resolveStagedClientRelease(
  platform: Platform,
  candidateId: string,
  sql: ExomemSql = executeExomemSql
): Promise<StagedClientRelease | null> {
  const { rows } = await sql`
    /* exomem:resolve-staged-client-release */
    SELECT id::text AS id, candidate_id::text AS candidate_id, platform, state, package_sha256,
           archive_sha256, compatibility_sha256, contract_sha256, plugin_version,
           oauth_client_config_sha256, registered_app_id_sha256, expires_at
    FROM exomem_staged_client_releases
    WHERE platform = ${platform} AND candidate_id = ${uuid(candidateId, "candidate ID")}::uuid
      AND state IN ('staged', 'evidenced') AND expires_at > now()
    LIMIT 2
  `;
  return rows.length === 1 ? stagedReleaseFromRow(rows[0]!) : null;
}

export async function expireCanaryAuthority(limit = 20): Promise<number> {
  const bounded = Math.min(100, Math.max(1, Math.floor(limit)));
  return withCohortLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:expire-canary-authority */
      WITH assignments AS (
        SELECT id FROM exomem_agent_contract_rollout_assignments
        WHERE state IN ('preparing', 'active') AND expires_at <= now()
        ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT ${bounded}
      ), expired_assignments AS (
        UPDATE exomem_agent_contract_rollout_assignments AS assignment
        SET state = 'expired', activated_at = NULL, ended_at = now(),
            version = version + 1, updated_at = now()
        FROM assignments WHERE assignment.id = assignments.id RETURNING assignment.id
      ), declarations AS (
        SELECT id FROM exomem_staged_client_releases
        WHERE state IN ('staged', 'evidenced') AND expires_at <= now()
        ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT ${bounded}
      ), expired_declarations AS (
        UPDATE exomem_staged_client_releases AS declaration
        SET state = 'expired', ended_at = now(), version = version + 1, updated_at = now()
        FROM declarations WHERE declaration.id = declarations.id
        RETURNING declaration.id
      )
      SELECT DISTINCT credential.tenant_id::text AS tenant_id,
             credential.candidate_id::text AS candidate_id,
             credential.assignment_id::text AS assignment_id,
             credential.assignment_generation,
             credential.staged_client_release_id::text AS staged_client_release_id
      FROM exomem_marketplace_reviewer_credentials AS credential
      WHERE credential.credential_kind = 'internal_canary'
        AND credential.revoked_at IS NULL
        AND (
          credential.assignment_id IN (SELECT id FROM expired_assignments)
          OR credential.staged_client_release_id IN (SELECT id FROM expired_declarations)
        )
    `;
    for (const row of rows) {
      await revokeCanaryOAuthLineageInTransaction(tx, {
        tenantId: String(row.tenant_id),
        candidateId: String(row.candidate_id),
        assignmentId: String(row.assignment_id),
        assignmentGeneration: integer(row.assignment_generation, "assignment generation"),
        stagedClientReleaseId: String(row.staged_client_release_id),
      });
    }
    return rows.length;
  });
}

export function isCanaryAssignmentState(value: unknown): value is AssignmentState {
  return (
    value === "preparing" ||
    value === "active" ||
    value === "failed" ||
    value === "expired" ||
    value === "retired"
  );
}

export function isStagedClientReleaseState(value: unknown): value is StageState {
  return (
    value === "staged" ||
    value === "evidenced" ||
    value === "failed" ||
    value === "expired" ||
    value === "retired"
  );
}
