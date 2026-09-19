import { createHash } from "node:crypto";
import { exomemHostedContractFixture } from "./agent-contract-fixture";
import { exomemContractFixture0770 } from "./gateway-contract-0-77-0";
import manifest0770 from "./runtime-target-0-77-0.json";

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

function checked0770(): TrustedHostedRuntimeTarget {
  const target = manifest0770.target;
  const agent = exomemHostedContractFixture;
  if (
    manifest0770.artifact !== "exomem-hosted-runtime-target-verification" ||
    manifest0770.schemaVersion !== 1 ||
    target.releaseVersion !== "0.77.0" ||
    target.releaseVersion !== agent.sourceRelease ||
    target.sourceCommit !== agent.sourceCommit ||
    target.agentProfile !== agent.compatibility.profile ||
    target.protocolVersion !== exomemContractFixture0770.protocol ||
    target.gatewayContractDigest !== exomemContractFixture0770.digest ||
    target.commandFingerprint !== agent.compatibility.command_surface_sha256 ||
    target.schemaDigest !== agent.compatibility.schema_contract_sha256 ||
    target.compatibilityDigest !== agent.compatibility.compatibility_sha256
  ) {
    throw new Error("reviewed runtime target differs from the checked release fixtures");
  }
  return Object.freeze({
    target: Object.freeze({ ...target }),
    runtimeTargetDigest: digest(target),
    verificationManifestDigest: digest(manifest0770),
  });
}

const trusted0770 = checked0770();

/** Only reviewed build-time verification evidence can populate this registry. */
export function getTrustedHostedRuntimeTarget(
  sourceRelease: string
): TrustedHostedRuntimeTarget | null {
  return sourceRelease === "0.77.0" ? trusted0770 : null;
}
