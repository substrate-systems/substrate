import { createHash } from "node:crypto";
import { exomemHostedContractFixture as agent0770 } from "./agent-contract-fixture-0-77-0";
import { exomemContractFixture0770 } from "./gateway-contract-0-77-0";
import manifest0770 from "./runtime-target-0-77-0.json";
import { exomemHostedContractFixture as agent0890 } from "./agent-contract-fixture";
import { exomemContractFixture0890 } from "./gateway-contract-0-89-0";
import manifest0890 from "./runtime-target-0-89-0.json";

export type HostedRuntimeTarget = Readonly<{
  releaseVersion: string;
  sourceCommit: string;
  runtimeImage: string;
  runtimeCandidateSha256: string;
  protocolVersion: string;
  agentProfile: string;
  gatewayContractDigest: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
}>;

export type TrustedHostedRuntimeTarget = Readonly<{
  target: HostedRuntimeTarget;
  runtimeTargetDigest: string;
  verificationManifestDigest: string;
}>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(`${JSON.stringify(canonical(value))}\n`)
    .digest("hex");
}

type VerificationManifest = {
  artifact: string;
  schemaVersion: number;
  target: HostedRuntimeTarget;
  verification: {
    consumerCommit: string;
    consumerReportSha256?: string;
    consumerPinReportSha256?: string;
  };
};
type AgentIdentity = {
  sourceRelease: string;
  sourceCommit: string;
  compatibility: {
    profile: string;
    command_surface_sha256: string;
    schema_contract_sha256: string;
    compatibility_sha256: string;
  };
};

function checked(
  release: string,
  manifest: VerificationManifest,
  agent: AgentIdentity,
  gateway: { protocol: string; digest: string }
): TrustedHostedRuntimeTarget {
  const target = manifest.target;
  const verification = manifest.verification;
  const validReport =
    manifest.schemaVersion === 1
      ? typeof verification.consumerReportSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(verification.consumerReportSha256) &&
        verification.consumerPinReportSha256 === undefined
      : manifest.schemaVersion === 2 &&
        typeof verification.consumerPinReportSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(verification.consumerPinReportSha256) &&
        verification.consumerReportSha256 === undefined;
  if (
    manifest.artifact !== "exomem-hosted-runtime-target-verification" ||
    !validReport ||
    !/^[a-f0-9]{40}$/.test(verification.consumerCommit) ||
    target.releaseVersion !== release ||
    target.releaseVersion !== agent.sourceRelease ||
    target.sourceCommit !== agent.sourceCommit ||
    target.agentProfile !== agent.compatibility.profile ||
    target.protocolVersion !== gateway.protocol ||
    target.gatewayContractDigest !== gateway.digest ||
    target.commandFingerprint !== agent.compatibility.command_surface_sha256 ||
    target.schemaDigest !== agent.compatibility.schema_contract_sha256 ||
    target.compatibilityDigest !== agent.compatibility.compatibility_sha256
  ) {
    throw new Error("reviewed runtime target differs from the checked release fixtures");
  }
  return Object.freeze({
    target: Object.freeze({ ...target }),
    runtimeTargetDigest: digest(target),
    verificationManifestDigest: digest(manifest),
  });
}

const trusted0770 = checked("0.77.0", manifest0770, agent0770, exomemContractFixture0770);
const trusted0890 = checked("0.89.0", manifest0890, agent0890, exomemContractFixture0890);

/** Only reviewed build-time verification evidence can populate this registry. */
export function getTrustedHostedRuntimeTarget(
  sourceRelease: string
): TrustedHostedRuntimeTarget | null {
  if (sourceRelease === "0.89.0") return trusted0890;
  return sourceRelease === "0.77.0" ? trusted0770 : null;
}
