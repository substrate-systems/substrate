import { executeExomemSql } from "./db";
import {
  revokeOAuthAccountForOwnerTenantAtomic,
  revokeOAuthTokenFamilyForOwner,
} from "./oauth-store";

export type OperatorOAuthClient = {
  id: string;
  enabled: boolean;
  admissionMode: "pinned" | "cimd";
  redirectCount: number;
};

export async function listOperatorOAuthClients(): Promise<OperatorOAuthClient[]> {
  const { rows } = await executeExomemSql`
    /* exomem:list-operator-oauth-clients */
    SELECT id, enabled, admission_mode, jsonb_array_length(redirect_uris)::integer AS redirect_count
    FROM exomem_oauth_clients
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return rows.flatMap((raw) => {
    const row = raw as Record<string, unknown>;
    const redirectCount = row.redirect_count;
    if (
      typeof row.id !== "string" ||
      typeof row.enabled !== "boolean" ||
      (row.admission_mode !== "pinned" && row.admission_mode !== "cimd") ||
      typeof redirectCount !== "number" ||
      !Number.isSafeInteger(redirectCount)
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        enabled: row.enabled,
        admissionMode: row.admission_mode,
        redirectCount,
      },
    ];
  });
}

export async function setOperatorOAuthClientEnabled(input: {
  clientRecordId: string;
  enabled: boolean;
}): Promise<boolean> {
  // Alpha rollout has no separate cohort table: invite eligibility, an enabled
  // approved client, and a live client artifact form the existing cohort gate.
  const { rows } = await executeExomemSql`
    /* exomem:set-operator-oauth-client-enabled */
    WITH cohort_lock AS (
      SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))
    )
    UPDATE exomem_oauth_clients
    SET enabled = ${input.enabled}, updated_at = now()
    FROM cohort_lock
    WHERE id = ${input.clientRecordId}::uuid
    RETURNING id
  `;
  return rows.length === 1;
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
  const { rows } = await executeExomemSql`
    /* exomem:demote-operator-client-artifact */
    WITH cohort_lock AS (
      SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))
    )
    UPDATE exomem_client_artifacts
    SET state = 'retired', retired_at = now()
    FROM cohort_lock
    WHERE id = ${artifactId}::uuid AND state = 'live'
    RETURNING id
  `;
  return rows.length === 1;
}
