import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

export type HostedRuntimeTrustTarget = {
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
};

export type HostedRuntimeTrustReport = {
  artifact: "exomem-hosted-substrate-runtime-trust";
  schemaVersion: 1;
  consumerCommit: string;
  target: HostedRuntimeTrustTarget;
  pinnedSites: string[];
  fixtureSha256s: { agent: string; gateway: string };
};

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const IMAGE = /^ghcr\.io\/artexis10\/exomem@sha256:[a-f0-9]{64}$/;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function exactTarget(value: unknown): HostedRuntimeTrustTarget {
  const target = record(value, "runtime target");
  const fields = [
    "releaseVersion",
    "sourceCommit",
    "runtimeImage",
    "runtimeCandidateSha256",
    "protocolVersion",
    "agentProfile",
    "gatewayContractDigest",
    "commandFingerprint",
    "schemaDigest",
    "compatibilityDigest",
  ] as const;
  if (
    Object.keys(target).sort().join("\0") !== [...fields].sort().join("\0") ||
    typeof target.releaseVersion !== "string" ||
    !RELEASE.test(target.releaseVersion) ||
    typeof target.sourceCommit !== "string" ||
    !COMMIT.test(target.sourceCommit) ||
    typeof target.runtimeImage !== "string" ||
    !IMAGE.test(target.runtimeImage) ||
    typeof target.protocolVersion !== "string" ||
    !/^[1-9][0-9]{0,7}$/.test(target.protocolVersion) ||
    typeof target.agentProfile !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(target.agentProfile)
  ) {
    throw new Error("runtime target identity is invalid");
  }
  for (const field of [
    "runtimeCandidateSha256",
    "gatewayContractDigest",
    "commandFingerprint",
    "schemaDigest",
    "compatibilityDigest",
  ] as const) {
    digest(target[field], `runtime target ${field}`);
  }
  return target as HostedRuntimeTrustTarget;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value;
}

export function canonicalHostedRuntimeTrustReport(report: HostedRuntimeTrustReport): string {
  return `${JSON.stringify(canonicalValue(report))}\n`;
}

function requireMarkers(source: string, label: string, markers: string[]): void {
  if (markers.some((marker) => !source.includes(marker))) {
    throw new Error(`${label} does not trust the exact runtime target`);
  }
}

export async function buildHostedRuntimeTrustReport(input: {
  repository: string;
  consumerCommit: string;
  target: unknown;
}): Promise<HostedRuntimeTrustReport> {
  if (!COMMIT.test(input.consumerCommit)) throw new Error("consumer commit is invalid");
  const target = exactTarget(input.target);
  const versionSlug = target.releaseVersion.replaceAll(".", "-");
  const fixtureIdentifier = `exomemContractFixture${versionSlug.replaceAll("-", "")}`;
  const agentFixtureIdentifier = `exomemHostedContractFixture${versionSlug.replaceAll("-", "")}`;
  const root = resolve(input.repository);
  const agentPath = resolve(root, "src/lib/exomem-hosted/__tests__/agent-contract-fixture.json");
  const gatewayPath = resolve(
    root,
    `src/lib/exomem-hosted/__tests__/gateway-contract-${versionSlug}.json`
  );
  const [agentBytes, gatewayBytes] = await Promise.all([
    readFile(agentPath),
    readFile(gatewayPath),
  ]);
  const agent = record(JSON.parse(agentBytes.toString("utf8")), "agent fixture");
  const compatibility = record(agent.compatibility, "agent compatibility");
  if (
    agent.sourceCommit !== target.sourceCommit ||
    agent.sourceRelease !== target.releaseVersion ||
    compatibility.profile !== target.agentProfile ||
    compatibility.command_surface_sha256 !== target.commandFingerprint ||
    compatibility.schema_contract_sha256 !== target.schemaDigest ||
    compatibility.compatibility_sha256 !== target.compatibilityDigest
  ) {
    throw new Error("agent fixture differs from the exact runtime target");
  }
  const gateway = record(JSON.parse(gatewayBytes.toString("utf8")), "gateway fixture");
  const gatewayDigest = record(gateway.digest, "gateway fixture digest");
  if (
    gateway.exomem_release !== target.releaseVersion ||
    gateway.protocol_version !== target.protocolVersion ||
    gatewayDigest.algorithm !== "sha256" ||
    gatewayDigest.value !== target.gatewayContractDigest
  ) {
    throw new Error("gateway fixture differs from the exact runtime target");
  }

  const sites = [
    {
      name: "admin-catalog",
      path: "src/app/api/exomem/admin/contracts/route.ts",
      markers: ["storeExomemAgentContractCandidate", "listExomemAgentContractStatus"],
    },
    {
      name: "agent-canaries",
      path: "src/lib/exomem-hosted/agent-contract-canaries.ts",
      markers: [`gateway-contract-${versionSlug}`, "gatewayContractDigests"],
    },
    {
      name: "agent-contract-store",
      path: "src/lib/exomem-hosted/agent-contract-store.ts",
      markers: [
        target.releaseVersion,
        target.sourceCommit,
        target.commandFingerprint,
        target.schemaDigest,
        target.compatibilityDigest,
      ],
    },
    {
      name: "client-artifacts",
      path: "src/lib/exomem-hosted/client-artifacts.ts",
      markers: ["agent-contract-fixture", agentFixtureIdentifier],
    },
    {
      name: "gateway-store",
      path: "src/lib/exomem-hosted/gateway.ts",
      markers: [`gateway-contract-${versionSlug}`, "agent-contract-fixture"],
    },
    {
      name: "lifecycle-store",
      path: "src/lib/exomem-hosted/lifecycle-store.ts",
      markers: [`gateway-contract-${versionSlug}`, `${fixtureIdentifier}.digest`],
    },
    {
      name: "oauth-bootstrap",
      path: "src/lib/exomem-hosted/__tests__/oauth-bootstrap-postgres.integration.test.ts",
      markers: [`gateway-contract-${versionSlug}`, `${fixtureIdentifier}.digest`],
    },
    {
      name: "platform-cohort",
      path: "src/lib/exomem-hosted/__tests__/platform-cohort-postgres.integration.test.ts",
      markers: [`gateway-contract-${versionSlug}`, "agent-contract-fixture"],
    },
    {
      name: "reviewer-operator",
      path: "src/lib/exomem-hosted/operator-controls.ts",
      markers: [`gateway-contract-${versionSlug}`, "createReviewerOAuthBootstrapAuthority"],
    },
  ];
  await Promise.all(
    sites.map(async (site) => {
      const source = await readFile(resolve(root, site.path), "utf8");
      requireMarkers(source, site.name, site.markers);
    })
  );
  return {
    artifact: "exomem-hosted-substrate-runtime-trust",
    schemaVersion: 1,
    consumerCommit: input.consumerCommit,
    target,
    pinnedSites: sites.map((site) => site.name).sort(),
    fixtureSha256s: { agent: sha256(agentBytes), gateway: sha256(gatewayBytes) },
  };
}
