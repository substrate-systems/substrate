import { createHash, createHmac } from "node:crypto";
import { exomemHostedContractFixture as liveFixture } from "../agent-contract-fixture";
import { exomemHostedContractFixture as candidateFixture0340 } from "../agent-contract-fixture-0-34-0";
import { exomemHostedContractFixture as candidateFixture0350 } from "../agent-contract-fixture-0-35-0";
import { exomemHostedContractFixture as retainedFixture0392 } from "../agent-contract-fixture-0-39-2";
import { exomemHostedContractFixture as retainedFixture0490 } from "../agent-contract-fixture-0-49-0";
import { exomemHostedContractFixture as retainedFixture0500 } from "../agent-contract-fixture-0-50-0";

export type PromotionFixtureRelease =
  | "0.34.0"
  | "0.35.0"
  | "0.39.2"
  | "0.49.0"
  | "0.50.0"
  | "0.72.1";

export function canonicalPromotionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPromotionJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalPromotionJson((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export function promotionContractFixture(release: PromotionFixtureRelease) {
  if (release === "0.34.0") return candidateFixture0340;
  if (release === "0.35.0") return candidateFixture0350;
  if (release === "0.39.2") return retainedFixture0392;
  if (release === "0.49.0") return retainedFixture0490;
  return release === "0.50.0" ? retainedFixture0500 : liveFixture;
}

export function testOpenAiLocks(
  release: PromotionFixtureRelease,
  digests?: { artifact: string; archive: string; registeredApp: string }
) {
  if (release === "0.72.1" && digests === undefined) {
    return {
      packageLock: liveFixture.openaiPackageLock,
      archiveLock: liveFixture.openaiArchiveLock,
    } as const;
  }
  const fixture = promotionContractFixture(release);
  const selectedDigests = digests ?? {
    artifact: "a".repeat(64),
    archive: "b".repeat(64),
    registeredApp: "c".repeat(64),
  };
  return {
    packageLock: {
      ...fixture.packageLock,
      platform: "openai" as const,
      artifact_sha256: selectedDigests.artifact,
      registered_app_id_sha256: selectedDigests.registeredApp,
    },
    archiveLock: {
      platform: "openai" as const,
      archive_sha256: selectedDigests.archive,
      registered_app_id_sha256: selectedDigests.registeredApp,
    },
  } as const;
}

// The live release ships its checked OpenAI registration locks alongside the
// Claude locks. Tests exercising the current candidate must preserve that
// exact identity rather than manufacturing a second registered app.
export const testOnlyOpenAiLocks = {
  packageLock: liveFixture.openaiPackageLock,
  archiveLock: liveFixture.openaiArchiveLock,
} as const;

export function signedPromotionEvidence(input: {
  platform: "claude" | "openai";
  release: PromotionFixtureRelease;
  secret: string;
  suffix: string;
  candidateId: string;
  stageId: string;
  assignmentId: string;
  assignmentGeneration: number;
  oauthClientConfigSha256?: string;
  openAiLocks?: ReturnType<typeof testOpenAiLocks>;
}): Record<string, unknown> {
  const fixture = promotionContractFixture(input.release);
  const openAiLocks = input.openAiLocks ?? testOpenAiLocks(input.release);
  const locks =
    input.platform === "claude"
      ? { packageLock: fixture.packageLock, archiveLock: fixture.archiveLock }
      : openAiLocks;
  const unsigned: Record<string, unknown> = {
    schema_version: 1,
    platform: input.platform,
    client_version: "1.0.0",
    clean_client_identity_hmac_sha256: "1".repeat(64),
    timestamp: new Date().toISOString(),
    paired_run_hmac_sha256: "2".repeat(64),
    test_identity: "hosted-client-plugins-v1",
    exomem_identity_hmac_sha256: "3".repeat(64),
    tenant_hmac_sha256: "4".repeat(64),
    entitlement_hmac_sha256: "5".repeat(64),
    provisioning_operation_hmac_sha256: "6".repeat(64),
    cell_hmac_sha256: "7".repeat(64),
    oauth_client_config_sha256: input.oauthClientConfigSha256 ?? "a".repeat(64),
    contract_candidate_id: input.candidateId,
    staged_client_release_id: input.stageId,
    assignment_id: input.assignmentId,
    assignment_generation: input.assignmentGeneration,
    identity_count: 1,
    tenant_count: 1,
    entitlement_count: 1,
    operation_count: 1,
    cell_count: 1,
    volume_count: 1,
    result_sha256: createHash("sha256").update(input.suffix).digest("hex"),
    package_artifact_sha256: locks.packageLock.artifact_sha256,
    archive_sha256: locks.archiveLock.archive_sha256,
    ...(input.platform === "openai"
      ? { registered_app_id_sha256: openAiLocks.packageLock.registered_app_id_sha256 }
      : {}),
    compatibility_sha256: fixture.compatibility.compatibility_sha256,
    schema_contract_sha256: fixture.compatibility.schema_contract_sha256,
    command_surface_sha256: fixture.compatibility.command_surface_sha256,
    endpoint: fixture.compatibility.endpoint,
    plugin_version: locks.packageLock.plugin_version,
    profile: fixture.compatibility.profile,
    operator_key_id: "integration-operator",
    native_install: true,
    authorization: true,
    tool_discovery: true,
    content_recall: true,
    citation: true,
    durable_capture: true,
    fresh_chat_recall: true,
  };
  return {
    ...unsigned,
    operator_signature: createHmac("sha256", input.secret)
      .update(canonicalPromotionJson(unsigned))
      .digest("hex"),
  };
}

export function evidence(
  platform: "claude" | "openai",
  secret: string,
  suffix: string,
  binding: {
    candidateId: string;
    stageId: string;
    assignmentId: string;
    assignmentGeneration: number;
  }
): Record<string, unknown> {
  return signedPromotionEvidence({
    platform,
    release: "0.72.1",
    secret,
    suffix,
    ...binding,
  });
}

export function pendingArtifactFromEvidence(
  platform: "claude" | "openai",
  signed: Record<string, unknown>,
  installUrl?: string
) {
  return {
    platform,
    state: "pending" as const,
    packageSha256: signed.package_artifact_sha256,
    archiveSha256: signed.archive_sha256,
    compatibilitySha256: signed.compatibility_sha256,
    contractSha256: signed.schema_contract_sha256,
    pluginVersion: signed.plugin_version,
    clientIdentitySha256: signed.clean_client_identity_hmac_sha256,
    pairedRunHmacSha256: signed.paired_run_hmac_sha256,
    exomemIdentityHmacSha256: signed.exomem_identity_hmac_sha256,
    tenantHmacSha256: signed.tenant_hmac_sha256,
    installUrl:
      installUrl ??
      (platform === "claude"
        ? process.env.EXOMEM_HOSTED_CLAUDE_INSTALL_URL
        : process.env.EXOMEM_HOSTED_OPENAI_INSTALL_URL),
    evidenceSha256: createHash("sha256").update(canonicalPromotionJson(signed)).digest("hex"),
    resultSha256: signed.result_sha256,
    oauthClientConfigSha256: signed.oauth_client_config_sha256,
    observedAt: signed.timestamp,
    candidateId: signed.contract_candidate_id,
    stagedClientReleaseId: signed.staged_client_release_id,
    assignmentId: signed.assignment_id,
    assignmentGeneration: signed.assignment_generation,
    evidence: signed,
  };
}
