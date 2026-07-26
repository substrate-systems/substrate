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
  admissionMode: "pinned" | "cimd";
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

type OperatorClientWriteResult = { id: string; enabled: boolean };

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
  input: OperatorOAuthClientRegistration,
  dependencies: { fetchCimd?: (clientId: string) => Promise<CimdFetchedMetadata> } = {}
): Promise<OperatorClientWriteResult> {
  let registration = normalizeOperatorOAuthClientRegistration(input);
  if (!registration.artifactId) throw exomemErrors.invalidRequest();
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
      FROM available CROSS JOIN artifact
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
      WHERE exomem_oauth_clients.oauth_client_config_sha256 IS NULL
         OR (
           exomem_oauth_clients.client_platform = EXCLUDED.client_platform
           AND exomem_oauth_clients.oauth_client_config_sha256 = EXCLUDED.oauth_client_config_sha256
         )
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
        ${input.enabled} = false OR EXISTS (
          SELECT 1 FROM exomem_client_artifacts AS artifact
          WHERE artifact.platform = client.client_platform
            AND artifact.state IN ('pending', 'live')
            AND artifact.oauth_client_config_sha256 = client.oauth_client_config_sha256
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
