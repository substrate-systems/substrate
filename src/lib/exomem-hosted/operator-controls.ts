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

export type OperatorOAuthClient = {
  id: string;
  enabled: boolean;
  admissionMode: "pinned" | "cimd" | "generic";
  clientFingerprint: string;
  redirectDigest: string;
  redirectCount: number;
  metadataExpiresAt: string | null;
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
      // A mode outside the schema's closed set drops the row; a known mode the
      // list omitted would hide registered clients from the operator.
      (row.admission_mode !== "pinned" &&
        row.admission_mode !== "cimd" &&
        row.admission_mode !== "generic") ||
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

type OperatorClientWriteResult = { id: string; enabled: boolean };
type StagedOperatorOAuthClientRegistration = OperatorOAuthClientRegistration & {
  stagedClientReleaseId?: string;
  existingClientRecordId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The agent profile that the retained Hosted staged-release rows carry. Operator
// client registration still names one of those rows, or a client artifact, as
// its authority. Delete this with that authority, when operator registration
// moves to a Cloud-native authority (follow-up to adopt-exomem-cloud-plain-cells 5.1).
const HOSTED_STAGE_PROFILE = "hosted-alpha-agent-v4";

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

export async function preflightReusablePinnedOAuthClient(input: {
  platform: "claude" | "openai";
  clientId: string;
  redirectUris: string[];
}): Promise<{ eligible: boolean; clientRecordId: string | null }> {
  const registration = normalizeOperatorOAuthClientRegistration({
    admissionMode: "pinned",
    platform: input.platform,
    clientId: input.clientId,
    redirectUris: input.redirectUris,
  });
  const configSha256 = oauthClientConfigSha256(registration);
  return withCohortControlLock(async (tx) => {
    const { rows } = await tx`
      /* exomem:preflight-reusable-pinned-oauth-client */
      SELECT client.id
      FROM exomem_oauth_clients AS client
      WHERE client.client_id = ${registration.clientId}
        AND client.admission_mode = 'pinned'
        AND client.client_platform = ${registration.platform}
        AND client.oauth_client_config_sha256 = ${configSha256}
        AND client.enabled = false
        AND client.reviewer_bootstrap_ever_authorized = false
        AND client.metadata_provenance->>'mode' = 'pinned'
      ORDER BY client.id
      LIMIT 2
    `;
    const identifiers = rows.flatMap((row) =>
      typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : []
    );
    return identifiers.length === 1
      ? { eligible: true, clientRecordId: identifiers[0]! }
      : { eligible: false, clientRecordId: null };
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
  const existingClientRecordId = input.existingClientRecordId;
  if (existingClientRecordId !== undefined) {
    if (
      registration.admissionMode !== "pinned" ||
      registration.artifactId !== undefined ||
      typeof stagedClientReleaseId !== "string" ||
      !UUID.test(stagedClientReleaseId) ||
      !UUID.test(existingClientRecordId)
    ) {
      throw exomemErrors.invalidRequest();
    }
    return withCohortControlLock(async (tx) => {
      const { rows } = await tx`
        /* exomem:reuse-operator-pinned-oauth-client */
        WITH stage AS (
          SELECT stage.id
          FROM exomem_staged_client_releases AS stage
          JOIN exomem_agent_contract_candidates AS candidate
            ON candidate.id = stage.candidate_id
           AND candidate.profile_id = ${HOSTED_STAGE_PROFILE}
           AND candidate.state IN ('pending', 'live')
          WHERE stage.id = ${stagedClientReleaseId}::uuid
            AND stage.platform = ${registration.platform}
            AND stage.state IN ('staged', 'evidenced')
            AND stage.expires_at > now()
            AND stage.oauth_client_config_sha256 = ${configSha256}
            AND stage.registered_app_id_sha256 IS NULL
        ), eligible AS (
          SELECT client.id
          FROM exomem_oauth_clients AS client CROSS JOIN stage
          WHERE client.id = ${existingClientRecordId}::uuid
            AND client.client_id = ${registration.clientId}
            AND client.admission_mode = 'pinned'
            AND client.client_platform = ${registration.platform}
            AND client.oauth_client_config_sha256 = ${configSha256}
            AND client.enabled = false
            AND client.reviewer_bootstrap_ever_authorized = false
            AND client.metadata_provenance->>'mode' = 'pinned'
        )
        UPDATE exomem_oauth_clients AS client
        SET authority_version = gen_random_uuid(), updated_at = now()
        FROM eligible
        WHERE client.id = eligible.id
        RETURNING client.id, client.enabled
      `;
      const row = rows[0] as { id: string; enabled: boolean } | undefined;
      if (!row || row.enabled) throw exomemErrors.invalidRequest();
      return { id: row.id, enabled: false };
    });
  }
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
        SELECT exomem_oauth_client_partition_available(${registration.clientId}, false) AS allowed
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
         AND candidate.profile_id = ${HOSTED_STAGE_PROFILE}
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
