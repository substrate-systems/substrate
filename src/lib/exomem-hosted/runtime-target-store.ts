import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { exomemErrors } from "./errors";
import { EXOMEM_HOSTED_PROFILE } from "./hosted-profile";
import {
  getTrustedHostedRuntimeTarget,
  type TrustedHostedRuntimeTarget,
} from "./runtime-target-registry";

export type RuntimeTargetImportResult = {
  candidateId: string;
  runtimeTargetDigest: string;
  outcome: "imported" | "unchanged";
};

type StoredRuntimeTarget = {
  candidate_id: string;
  release_version: string;
  source_commit: string;
  runtime_image: string;
  runtime_candidate_sha256: string;
  protocol_version: string;
  agent_profile: string;
  gateway_contract_digest: string;
  command_fingerprint: string;
  schema_digest: string;
  compatibility_digest: string;
  runtime_target_digest: string;
  verification_manifest_digest: string;
};

function matchesTrustedTarget(
  stored: StoredRuntimeTarget,
  trusted: TrustedHostedRuntimeTarget
): boolean {
  const target = trusted.target;
  return (
    stored.release_version === target.releaseVersion &&
    stored.source_commit === target.sourceCommit &&
    stored.runtime_image === target.runtimeImage &&
    stored.runtime_candidate_sha256 === target.runtimeCandidateSha256 &&
    stored.protocol_version === target.protocolVersion &&
    stored.agent_profile === target.agentProfile &&
    stored.gateway_contract_digest === target.gatewayContractDigest &&
    stored.command_fingerprint === target.commandFingerprint &&
    stored.schema_digest === target.schemaDigest &&
    stored.compatibility_digest === target.compatibilityDigest &&
    stored.runtime_target_digest === trusted.runtimeTargetDigest &&
    stored.verification_manifest_digest === trusted.verificationManifestDigest
  );
}

export async function importTrustedHostedRuntimeTarget(input: {
  candidateId: string;
  operatorPrincipalDigest: Buffer;
}): Promise<RuntimeTargetImportResult> {
  return withExomemTransaction(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('exomem-hosted-alpha-cohort'))`;
    const { rows: candidates } = await transaction`
      SELECT id::text AS candidate_id, source_release, profile_id, protocol_version,
             command_fingerprint, schema_digest, compatibility_digest
      FROM exomem_agent_contract_candidates
      WHERE id = ${input.candidateId}::uuid
        AND profile_id = ${EXOMEM_HOSTED_PROFILE}
      FOR UPDATE
    `;
    const candidate = candidates[0] as Record<string, unknown> | undefined;
    if (!candidate || typeof candidate.source_release !== "string")
      throw exomemErrors.invalidRequest();
    const trusted = getTrustedHostedRuntimeTarget(candidate.source_release);
    if (
      !trusted ||
      candidate.source_release !== trusted.target.releaseVersion ||
      candidate.profile_id !== trusted.target.agentProfile ||
      candidate.protocol_version !== trusted.target.protocolVersion ||
      candidate.command_fingerprint !== trusted.target.commandFingerprint ||
      candidate.schema_digest !== trusted.target.schemaDigest ||
      candidate.compatibility_digest !== trusted.target.compatibilityDigest
    )
      throw exomemErrors.invalidRequest();
    const { rows: existingRows } = await transaction`
      SELECT candidate_id::text, release_version, source_commit, runtime_image,
             runtime_candidate_sha256, protocol_version, agent_profile,
             gateway_contract_digest, command_fingerprint, schema_digest,
             compatibility_digest, runtime_target_digest, verification_manifest_digest
      FROM exomem_runtime_targets
      WHERE candidate_id = ${input.candidateId}::uuid
      FOR UPDATE
    `;
    const existing = existingRows[0] as StoredRuntimeTarget | undefined;
    if (existing) {
      if (!matchesTrustedTarget(existing, trusted)) throw exomemErrors.idempotencyConflict();
      return {
        candidateId: input.candidateId,
        runtimeTargetDigest: trusted.runtimeTargetDigest,
        outcome: "unchanged",
      };
    }
    const target = trusted.target;
    await transaction`
      INSERT INTO exomem_runtime_targets (
        candidate_id, release_version, source_commit, runtime_image, runtime_candidate_sha256,
        protocol_version, agent_profile, gateway_contract_digest, command_fingerprint,
        schema_digest, compatibility_digest, runtime_target_digest,
        verification_manifest_digest, imported_by_principal_digest
      ) VALUES (
        ${input.candidateId}::uuid, ${target.releaseVersion}, ${target.sourceCommit},
        ${target.runtimeImage}, ${target.runtimeCandidateSha256}, ${target.protocolVersion},
        ${target.agentProfile}, ${target.gatewayContractDigest}, ${target.commandFingerprint},
        ${target.schemaDigest}, ${target.compatibilityDigest}, ${trusted.runtimeTargetDigest},
        ${trusted.verificationManifestDigest}, ${input.operatorPrincipalDigest}
      )
    `;
    return {
      candidateId: input.candidateId,
      runtimeTargetDigest: trusted.runtimeTargetDigest,
      outcome: "imported",
    };
  });
}

export async function getImportedHostedRuntimeTarget(
  candidateId: string,
  tx: ExomemSql
): Promise<StoredRuntimeTarget | null> {
  const { rows } = await tx`
    SELECT candidate_id::text, release_version, source_commit, runtime_image,
           runtime_candidate_sha256, protocol_version, agent_profile,
           gateway_contract_digest, command_fingerprint, schema_digest,
           compatibility_digest, runtime_target_digest, verification_manifest_digest
    FROM exomem_runtime_targets
    WHERE candidate_id = ${candidateId}::uuid
  `;
  const stored = rows[0] as StoredRuntimeTarget | undefined;
  if (!stored) return null;
  const trusted = getTrustedHostedRuntimeTarget(stored.release_version);
  return trusted && matchesTrustedTarget(stored, trusted) ? stored : null;
}

export async function listHostedRuntimeTargetStatus(): Promise<
  Array<{
    candidateId: string;
    sourceRelease: string;
    importReady: boolean;
    runtimeTargetDigest: string | null;
  }>
> {
  const { rows } = await executeExomemSql`
    SELECT candidate.id::text AS candidate_id, candidate.source_release,
           candidate.profile_id, candidate.protocol_version, candidate.command_fingerprint,
           candidate.schema_digest, candidate.compatibility_digest,
           target.runtime_target_digest
    FROM exomem_agent_contract_candidates AS candidate
    LEFT JOIN exomem_runtime_targets AS target ON target.candidate_id = candidate.id
    WHERE candidate.profile_id = ${EXOMEM_HOSTED_PROFILE}
    ORDER BY candidate.created_at, candidate.id
  `;
  return rows.flatMap((row) => {
    if (typeof row.candidate_id !== "string" || typeof row.source_release !== "string") return [];
    const trusted = getTrustedHostedRuntimeTarget(row.source_release);
    const importReady =
      trusted !== null &&
      row.protocol_version === trusted.target.protocolVersion &&
      row.command_fingerprint === trusted.target.commandFingerprint &&
      row.schema_digest === trusted.target.schemaDigest &&
      row.compatibility_digest === trusted.target.compatibilityDigest;
    return [
      {
        candidateId: row.candidate_id,
        sourceRelease: row.source_release,
        importReady,
        runtimeTargetDigest:
          typeof row.runtime_target_digest === "string" ? row.runtime_target_digest : null,
      },
    ];
  });
}
