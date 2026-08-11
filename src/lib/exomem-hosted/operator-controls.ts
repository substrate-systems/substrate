import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { exomemErrors } from "./errors";
import {
  revokeOAuthAccountForOwnerTenantAtomic,
  revokeOAuthTokenFamilyForOwner,
} from "./oauth-store";
import {
  documentDigest,
  fetchCimdMetadata,
  normalizeOperatorOAuthClientRegistration,
  oauthClientConfigSha256,
  operatorOAuthClientFingerprint,
  type CimdFetchedMetadata,
  type OperatorOAuthClientRegistration,
} from "./oauth-client-admission";
import { exomemContractFixture0392 } from "./gateway-contract-0-39-2";

export type OperatorOAuthClient = {
  id: string;
  enabled: boolean;
  admissionMode: "pinned" | "cimd";
  clientFingerprint: string;
  redirectDigest: string;
  redirectCount: number;
  metadataExpiresAt: string | null;
};

export type ReviewerOAuthBootstrapAuthority = {
  id: string;
  state: "active" | "consumed" | "revoked" | "expired";
  expiresAt: string;
  outcomeTenantId: string | null;
  outcomeAssignmentId: string | null;
  outcomeAssignmentGeneration: number | null;
  outcomeOperationId: string | null;
  outcomeSessionId: string | null;
  outcomeGrantId: string | null;
};

async function withCohortControlLock<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  return withExomemTransaction(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    return work(tx);
  });
}

export async function listOperatorOAuthClients(): Promise<OperatorOAuthClient[]> {
  const { rows } = await executeExomemSql`
    /* exomem:list-operator-oauth-clients */
    SELECT id, client_id, enabled, admission_mode, redirect_uris_digest, metadata_expires_at,
           jsonb_array_length(redirect_uris)::integer AS redirect_count
    FROM exomem_oauth_clients
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const redirectCount = row.redirect_count;
    const redirectDigest = row.redirect_uris_digest;
    if (
      typeof row.id !== "string" ||
      typeof row.enabled !== "boolean" ||
      (row.admission_mode !== "pinned" && row.admission_mode !== "cimd") ||
      typeof redirectCount !== "number" ||
      !Number.isSafeInteger(redirectCount) ||
      !(redirectDigest instanceof Uint8Array) ||
      redirectDigest.byteLength !== 32 ||
      (row.metadata_expires_at !== null && !(row.metadata_expires_at instanceof Date))
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        enabled: row.enabled,
        admissionMode: row.admission_mode,
        clientFingerprint: operatorOAuthClientFingerprint(String(row.client_id ?? row.id)),
        redirectDigest: Buffer.from(redirectDigest).toString("hex"),
        redirectCount,
        metadataExpiresAt:
          row.metadata_expires_at instanceof Date ? row.metadata_expires_at.toISOString() : null,
      },
    ];
  });
}

export async function listReviewerOAuthBootstrapAuthorities(): Promise<
  ReviewerOAuthBootstrapAuthority[]
> {
  const { rows } = await executeExomemSql`
    /* exomem:list-reviewer-oauth-bootstrap-authorities */
    SELECT id::text AS id, state, expires_at, outcome_tenant_id::text AS outcome_tenant_id,
           outcome_assignment_id::text AS outcome_assignment_id, outcome_assignment_generation,
           outcome_operation_id::text AS outcome_operation_id,
           outcome_session_id::text AS outcome_session_id, outcome_grant_id::text AS outcome_grant_id
    FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
    ORDER BY created_at DESC LIMIT 20
  `;
  return rows.flatMap((row) => {
    if (
      typeof row.id !== "string" ||
      (row.state !== "active" &&
        row.state !== "consumed" &&
        row.state !== "revoked" &&
        row.state !== "expired") ||
      !(row.expires_at instanceof Date)
    )
      return [];
    return [
      {
        id: row.id,
        state: row.state,
        expiresAt: row.expires_at.toISOString(),
        outcomeTenantId: typeof row.outcome_tenant_id === "string" ? row.outcome_tenant_id : null,
        outcomeAssignmentId:
          typeof row.outcome_assignment_id === "string" ? row.outcome_assignment_id : null,
        outcomeAssignmentGeneration:
          typeof row.outcome_assignment_generation === "number"
            ? row.outcome_assignment_generation
            : null,
        outcomeOperationId:
          typeof row.outcome_operation_id === "string" ? row.outcome_operation_id : null,
        outcomeSessionId:
          typeof row.outcome_session_id === "string" ? row.outcome_session_id : null,
        outcomeGrantId: typeof row.outcome_grant_id === "string" ? row.outcome_grant_id : null,
      },
    ];
  });
}

export async function createReviewerOAuthBootstrapAuthority(input: {
  inviteId: string;
  stagedClientReleaseId: string;
  oauthClientId: string;
  expiresAt: Date;
  operatorPrincipalDigest: Buffer;
}): Promise<{ id: string; expiresAt: string } | null> {
  if (
    !UUID.test(input.inviteId) ||
    !UUID.test(input.stagedClientReleaseId) ||
    !UUID.test(input.oauthClientId) ||
    input.operatorPrincipalDigest.byteLength !== 32 ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= Date.now() ||
    input.expiresAt.getTime() > Date.now() + 30 * 60_000
  )
    throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    await tx`
      WITH expired AS (
        UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
        SET state = 'expired', expired_at = now()
        WHERE state = 'active' AND expires_at <= now()
        RETURNING oauth_client_id
      )
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = now()
      WHERE client.id IN (SELECT oauth_client_id FROM expired)
    `;
    const { rows } = await tx`
      /* exomem:create-reviewer-oauth-bootstrap-authority */
      WITH invite AS (
        SELECT id, expires_at
        FROM exomem_invites
        WHERE id = ${input.inviteId}::uuid
          AND marketplace_reviewer_purpose = true
          AND delivery_state = 'sent' AND delivered_at IS NOT NULL
          AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE
      ), stage AS (
        SELECT stage.id, stage.candidate_id, stage.platform, stage.oauth_client_config_sha256,
               stage.expires_at, candidate.profile_id, candidate.schema_digest AS contract_sha256,
               candidate.source_release, candidate.protocol_version, candidate.command_fingerprint,
               candidate.compatibility_digest
        FROM exomem_staged_client_releases AS stage
        JOIN exomem_agent_contract_candidates AS candidate
         ON candidate.id = stage.candidate_id
         AND candidate.profile_id = 'hosted-alpha-agent-v1'
         AND candidate.source_release = ${exomemContractFixture0392.release}
         AND candidate.protocol_version = ${exomemContractFixture0392.protocol}
         AND candidate.state = 'pending'
        WHERE stage.id = ${input.stagedClientReleaseId}::uuid
         AND stage.state = 'staged' AND stage.expires_at > now()
         AND stage.contract_sha256 = candidate.schema_digest
         AND stage.compatibility_sha256 = candidate.compatibility_digest
        FOR UPDATE OF stage, candidate
      ), client AS (
        UPDATE exomem_oauth_clients AS client
        SET enabled = true, reviewer_bootstrap_ever_authorized = true,
            authority_version = gen_random_uuid(), updated_at = now()
        FROM stage
        WHERE client.id = ${input.oauthClientId}::uuid
          AND client.admission_mode = 'pinned'
          AND client.client_platform = stage.platform
          AND client.oauth_client_config_sha256 = stage.oauth_client_config_sha256
          AND jsonb_array_length(client.redirect_uris) = 1
          AND client.redirect_uris->>0 ~ '^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?(/|$)'
          AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
          AND NOT EXISTS (
            SELECT 1 FROM exomem_hosted_alpha_cohort
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities
            WHERE state = 'active'
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_agent_contract_rollout_assignments AS assignment
            WHERE assignment.marketplace_reviewer_purpose = true
              AND assignment.state = 'active' AND assignment.expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
            WHERE credential.credential_kind = 'internal_canary'
              AND credential.revoked_at IS NULL AND credential.expires_at > now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_tenants AS tenant
            JOIN exomem_cells AS cell ON cell.id = tenant.bound_cell_id
            WHERE tenant.marketplace_reviewer_purpose = true
              AND tenant.deleted_at IS NULL
              AND (cell.routing_state = 'bound' OR cell.readiness_code = 'CELL_READY')
          )
        RETURNING client.id, client.authority_version, client.oauth_client_config_sha256,
                  client.redirect_uris_digest
      ), authority AS (
        INSERT INTO exomem_marketplace_reviewer_oauth_bootstrap_authorities (
          state, invite_id, candidate_id, candidate_profile_id, candidate_contract_digest,
          candidate_source_release, candidate_protocol_version, candidate_gateway_contract_digest,
          candidate_command_fingerprint, candidate_schema_digest, candidate_compatibility_digest,
          staged_client_release_id, stage_platform, stage_config_sha256, oauth_client_id,
          oauth_client_authority_version, oauth_client_config_sha256, redirect_uri_digest,
          operator_principal_digest, expires_at
        )
        SELECT 'active', invite.id, stage.candidate_id, stage.profile_id, stage.contract_sha256,
               stage.source_release, stage.protocol_version, ${exomemContractFixture0392.digest},
               stage.command_fingerprint, stage.contract_sha256, stage.compatibility_digest,
               stage.id, stage.platform, stage.oauth_client_config_sha256, client.id,
               client.authority_version, client.oauth_client_config_sha256, client.redirect_uris_digest,
               ${input.operatorPrincipalDigest}, LEAST(${input.expiresAt.toISOString()}::timestamptz, invite.expires_at, stage.expires_at)
        FROM invite CROSS JOIN stage CROSS JOIN client
        WHERE ${input.expiresAt.toISOString()}::timestamptz <= invite.expires_at
          AND ${input.expiresAt.toISOString()}::timestamptz <= stage.expires_at
        RETURNING id::text AS id, expires_at
      ) SELECT * FROM authority
    `;
    const row = rows[0] as { id?: string; expires_at?: Date } | undefined;
    return row?.id && row.expires_at instanceof Date
      ? { id: row.id, expiresAt: row.expires_at.toISOString() }
      : null;
  });
}

export async function revokeReviewerOAuthBootstrapAuthority(input: {
  authorityId: string;
}): Promise<boolean> {
  if (!UUID.test(input.authorityId)) throw exomemErrors.invalidRequest();
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:revoke-reviewer-oauth-bootstrap-authority */
      WITH revoked AS (
        UPDATE exomem_marketplace_reviewer_oauth_bootstrap_authorities
        SET state = 'revoked', revoked_at = now()
        WHERE id = ${input.authorityId}::uuid AND state = 'active'
        RETURNING oauth_client_id
      )
      UPDATE exomem_oauth_clients AS client
      SET enabled = false, authority_version = gen_random_uuid(), updated_at = now()
      WHERE client.id IN (SELECT oauth_client_id FROM revoked)
      RETURNING client.id
    `;
    return rows.length === 1;
  });
}

type OperatorClientWriteResult = { id: string; enabled: boolean };
type StagedOperatorOAuthClientRegistration = OperatorOAuthClientRegistration & {
  stagedClientReleaseId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function metadataProvenance(input: {
  mode: "pinned" | "cimd";
  host?: string;
  documentDigest?: Buffer;
}): string {
  return JSON.stringify({
    version: 1,
    mode: input.mode,
    ...(input.host ? { host: input.host } : {}),
    ...(input.documentDigest ? { documentDigest: input.documentDigest.toString("hex") } : {}),
  });
}

/** Register a pre-approved client only. Runtime authorization never creates or fetches a client. */
export async function registerOperatorOAuthClient(
  input: StagedOperatorOAuthClientRegistration,
  dependencies: { fetchCimd?: (clientId: string) => Promise<CimdFetchedMetadata> } = {}
): Promise<OperatorClientWriteResult> {
  const registration = normalizeOperatorOAuthClientRegistration(input);
  const stagedClientReleaseId = input.stagedClientReleaseId;
  if (
    !registration.artifactId &&
    (typeof stagedClientReleaseId !== "string" || !UUID.test(stagedClientReleaseId))
  )
    throw exomemErrors.invalidRequest();
  const configSha256 = oauthClientConfigSha256({
    platform: registration.platform,
    admissionMode: registration.admissionMode,
    clientId: registration.clientId,
    redirectUris: registration.redirectUris,
  });
  let fetched: CimdFetchedMetadata | null = null;
  if (registration.admissionMode === "cimd") {
    fetched = await (dependencies.fetchCimd ?? fetchCimdMetadata)(registration.clientId);
    if (
      fetched.document.client_id !== registration.clientId ||
      JSON.stringify(fetched.document.redirect_uris) !== JSON.stringify(registration.redirectUris)
    ) {
      throw exomemErrors.invalidRequest();
    }
  }
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:register-operator-oauth-client */
      WITH available AS (
        SELECT count(*) < 32
          OR EXISTS (SELECT 1 FROM exomem_oauth_clients WHERE client_id = ${registration.clientId})
          AS allowed
        FROM exomem_oauth_clients
      ), artifact AS (
        SELECT id FROM exomem_client_artifacts
        WHERE id = ${registration.artifactId}::uuid
          AND platform = ${registration.platform}
          AND state IN ('pending', 'live')
          AND oauth_client_config_sha256 = ${configSha256}
      ), stage AS (
        SELECT stage.id
        FROM exomem_staged_client_releases AS stage
        JOIN exomem_agent_contract_candidates AS candidate
          ON candidate.id = stage.candidate_id
         AND candidate.profile_id = 'hosted-alpha-agent-v1'
         AND candidate.state IN ('pending', 'live')
        WHERE stage.id = ${stagedClientReleaseId ?? "00000000-0000-0000-0000-000000000000"}::uuid
          AND stage.platform = ${registration.platform}
          AND stage.state IN ('staged', 'evidenced')
          AND stage.expires_at > now()
          AND stage.oauth_client_config_sha256 = ${configSha256}
          AND stage.registered_app_id_sha256 IS NOT DISTINCT FROM ${registration.registeredAppIdSha256 ?? null}
      ), authority AS (
        SELECT id FROM artifact
        UNION ALL
        SELECT id FROM stage
      )
      INSERT INTO exomem_oauth_clients (
        client_id, admission_mode, enabled, metadata_provenance, redirect_uris,
        redirect_uris_digest, metadata_document_digest, metadata_fetched_at,
        metadata_ttl_seconds, metadata_expires_at, cimd_host, client_platform,
        oauth_client_config_sha256, authority_version
      )
      SELECT ${registration.clientId}, ${registration.admissionMode}, false,
             ${metadataProvenance({
               mode: registration.admissionMode,
               ...(fetched
                 ? {
                     host: new URL(registration.clientId).hostname,
                     documentDigest: documentDigest(fetched.raw),
                   }
                 : {}),
             })}::jsonb,
             ${JSON.stringify(registration.redirectUris)}::jsonb,
             digest(convert_to(${JSON.stringify(registration.redirectUris)}::jsonb::text, 'utf8'), 'sha256'),
             ${fetched ? documentDigest(fetched.raw) : null},
             CASE WHEN ${fetched !== null} THEN now() ELSE NULL END,
             ${fetched ? registration.ttlSeconds : null},
             CASE WHEN ${fetched !== null}
               THEN now() + (${fetched ? registration.ttlSeconds : 0} * interval '1 second')
               ELSE NULL END,
             ${fetched ? new URL(registration.clientId).hostname.toLowerCase() : null},
             ${registration.platform}, ${configSha256},
             gen_random_uuid()
      FROM available CROSS JOIN authority
      WHERE available.allowed
      ON CONFLICT (client_id) DO UPDATE
      SET admission_mode = EXCLUDED.admission_mode,
          metadata_provenance = EXCLUDED.metadata_provenance,
          redirect_uris = EXCLUDED.redirect_uris,
          redirect_uris_digest = EXCLUDED.redirect_uris_digest,
          metadata_document_digest = EXCLUDED.metadata_document_digest,
          metadata_fetched_at = EXCLUDED.metadata_fetched_at,
          metadata_ttl_seconds = EXCLUDED.metadata_ttl_seconds,
          metadata_expires_at = EXCLUDED.metadata_expires_at,
          cimd_host = EXCLUDED.cimd_host,
          client_platform = EXCLUDED.client_platform,
          oauth_client_config_sha256 = EXCLUDED.oauth_client_config_sha256,
          enabled = CASE
            WHEN exomem_oauth_clients.oauth_client_config_sha256 IS NULL THEN false
            ELSE exomem_oauth_clients.enabled
          END,
          authority_version = gen_random_uuid(), updated_at = now()
        WHERE (
          exomem_oauth_clients.oauth_client_config_sha256 IS NULL
          OR (
           exomem_oauth_clients.client_platform = EXCLUDED.client_platform
           AND exomem_oauth_clients.oauth_client_config_sha256 = EXCLUDED.oauth_client_config_sha256
          )
        )
        AND exomem_oauth_clients.reviewer_bootstrap_ever_authorized = false
      RETURNING id, enabled
    `;
    const row = rows[0] as { id: string; enabled: boolean } | undefined;
    if (!row) throw exomemErrors.invalidRequest();
    return { id: row.id, enabled: row.enabled };
  });
}

/** Refresh happens outside the authority transaction, then commits only if the observed authority is unchanged. */
export async function refreshOperatorCimdOAuthClient(
  clientRecordId: string,
  dependencies: { fetchCimd?: (clientId: string) => Promise<CimdFetchedMetadata> } = {}
): Promise<OperatorClientWriteResult> {
  const { rows } = await executeExomemSql`
    /* exomem:read-operator-cimd-client-refresh */
    SELECT client_id, admission_mode, metadata_ttl_seconds, authority_version, client_platform,
           oauth_client_config_sha256
    FROM exomem_oauth_clients WHERE id = ${clientRecordId}::uuid LIMIT 1
  `;
  const current = rows[0] as
    | {
        client_id: string;
        admission_mode: string;
        metadata_ttl_seconds: number;
        authority_version: string;
        client_platform: "claude" | "openai";
        oauth_client_config_sha256: string;
      }
    | undefined;
  if (!current || current.admission_mode !== "cimd") throw exomemErrors.invalidRequest();
  const fetched = await (dependencies.fetchCimd ?? fetchCimdMetadata)(current.client_id);
  if (fetched.document.client_id !== current.client_id) throw exomemErrors.invalidRequest();
  const refreshed = normalizeOperatorOAuthClientRegistration({
    admissionMode: "cimd",
    platform: current.client_platform,
    clientId: current.client_id,
    redirectUris: fetched.document.redirect_uris,
    ttlSeconds: current.metadata_ttl_seconds,
  });
  const refreshedConfigSha256 = oauthClientConfigSha256({
    platform: refreshed.platform,
    admissionMode: refreshed.admissionMode,
    clientId: refreshed.clientId,
    redirectUris: refreshed.redirectUris,
  });
  if (current.oauth_client_config_sha256 !== refreshedConfigSha256) {
    await withCohortControlLock(async (tx) => {
      await tx`
        UPDATE exomem_oauth_clients
        SET enabled = false, updated_at = now()
        WHERE id = ${clientRecordId}::uuid AND authority_version = ${current.authority_version}::uuid
      `;
    });
    throw exomemErrors.invalidRequest();
  }
  return withCohortControlLock(async (tx) => {
    const { rows: updated } = await tx`
      /* exomem:refresh-operator-cimd-client */
      UPDATE exomem_oauth_clients
      SET redirect_uris = ${JSON.stringify(refreshed.redirectUris)}::jsonb,
          redirect_uris_digest = digest(convert_to(${JSON.stringify(refreshed.redirectUris)}::jsonb::text, 'utf8'), 'sha256'),
          metadata_document_digest = ${documentDigest(fetched.raw)},
          metadata_fetched_at = now(),
          metadata_ttl_seconds = ${refreshed.ttlSeconds},
          metadata_expires_at = now() + (${refreshed.ttlSeconds} * interval '1 second'),
          metadata_provenance = ${metadataProvenance({
            mode: "cimd",
            host: new URL(refreshed.clientId).hostname,
            documentDigest: documentDigest(fetched.raw),
          })}::jsonb,
          cimd_host = ${new URL(refreshed.clientId).hostname.toLowerCase()},
          enabled = CASE
            WHEN metadata_document_digest = ${documentDigest(fetched.raw)}
             AND redirect_uris_digest = digest(convert_to(${JSON.stringify(refreshed.redirectUris)}::jsonb::text, 'utf8'), 'sha256')
            THEN enabled ELSE false END,
          authority_version = gen_random_uuid(), updated_at = now()
      WHERE id = ${clientRecordId}::uuid
        AND admission_mode = 'cimd'
        AND authority_version = ${current.authority_version}::uuid
      RETURNING id, enabled
    `;
    const row = updated[0] as { id: string; enabled: boolean } | undefined;
    if (!row) throw exomemErrors.invalidRequest();
    return { id: row.id, enabled: row.enabled };
  });
}

export async function setOperatorOAuthClientEnabled(input: {
  clientRecordId: string;
  enabled: boolean;
}): Promise<boolean> {
  // Alpha rollout has no separate cohort table: invite eligibility, an enabled
  // approved client, and a live client artifact form the existing cohort gate.
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:set-operator-oauth-client-enabled */
    UPDATE exomem_oauth_clients AS client
    SET enabled = ${input.enabled}, updated_at = now()
    WHERE client.id = ${input.clientRecordId}::uuid
      AND (
        (${input.enabled} = false) OR (
          client.reviewer_bootstrap_ever_authorized = false AND EXISTS (
          SELECT 1 FROM exomem_client_artifacts AS artifact
          WHERE artifact.platform = client.client_platform
            AND artifact.state IN ('pending', 'live')
            AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
          )
        )
      )
    RETURNING id
  `;
    return rows.length === 1;
  });
}

export const revokeOperatorOAuthFamily = revokeOAuthTokenFamilyForOwner;
export const revokeOperatorOAuthAccount = revokeOAuthAccountForOwnerTenantAtomic;

export type OperatorClientArtifact = {
  id: string;
  platform: "claude" | "openai";
  state: "pending" | "live" | "failed" | "retired";
  packageSha256: string;
  archiveSha256: string;
  compatibilitySha256: string;
  contractSha256: string;
};

export async function listOperatorClientArtifacts(): Promise<OperatorClientArtifact[]> {
  const { rows } = await executeExomemSql`
    /* exomem:list-operator-client-artifacts */
    SELECT id, platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256
    FROM exomem_client_artifacts
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const packageSha256 = row.package_sha256;
    const archiveSha256 = row.archive_sha256;
    const compatibilitySha256 = row.compatibility_sha256;
    const contractSha256 = row.contract_sha256;
    if (
      typeof row.id !== "string" ||
      (row.platform !== "claude" && row.platform !== "openai") ||
      (row.state !== "pending" &&
        row.state !== "live" &&
        row.state !== "failed" &&
        row.state !== "retired") ||
      ![packageSha256, archiveSha256, compatibilitySha256, contractSha256].every(
        (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
      )
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        platform: row.platform,
        state: row.state,
        packageSha256: packageSha256 as string,
        archiveSha256: archiveSha256 as string,
        compatibilitySha256: compatibilitySha256 as string,
        contractSha256: contractSha256 as string,
      },
    ];
  });
}

/** Preserve the schema's only valid demotion transition: live to retired. */
export async function demoteOperatorClientArtifact(artifactId: string): Promise<boolean> {
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
    /* exomem:demote-operator-client-artifact */
    UPDATE exomem_client_artifacts
    SET state = 'retired', retired_at = now()
    WHERE id = ${artifactId}::uuid AND state = 'live'
    RETURNING id
  `;
    return rows.length === 1;
  });
}
