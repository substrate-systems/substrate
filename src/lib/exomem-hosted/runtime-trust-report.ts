import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import ts from "typescript";

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
// The ten-field output of `hosted_image_candidate.py verify` for Exomem v0.68.0,
// which checks the release's Sigstore attestation and cross-checks the agent and
// gateway fixtures against the signed candidate. Do not hand-assemble this.
const REVIEWED_TARGET: HostedRuntimeTrustTarget = {
  releaseVersion: "0.68.0",
  sourceCommit: "76571f2c9f600395344a2a62efe6aca36d32b42d",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:78762e5676a57fff444d1360a968ba9d34d9cb5e6032f80542b813645ce765b0",
  runtimeCandidateSha256: "e6a98f21bc4910f320b959d510989dc96c5c0746c0f7957aff3f5748eac85784",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v4",
  gatewayContractDigest: "4e19849239188017b727a7ec97fe6e8505a01d216907957755676f3f588b8cd6",
  commandFingerprint: "4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968",
  schemaDigest: "124fb718c6d2b6caee93edd7281fbc6cd7ca991e4a39bcc90df00bf0811208fd",
  compatibilityDigest: "62356a1220b823e9ae91e1fab18a8da5711481b6cc907dbcae033e254a3585dc",
};

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

function committedBytes(repository: string, commit: string, path: string): Buffer {
  try {
    const type = execFileSync("git", ["-C", repository, "cat-file", "-t", commit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (type !== "commit") throw new Error("not a commit");
    return execFileSync("git", ["-C", repository, "show", `${commit}:${path}`], {
      encoding: "buffer",
      maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("consumer commit or pinned file is unavailable");
  }
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

type TrustedImport = { module: string; symbol: string };

export function assertRuntimeTrustImport(
  source: string,
  label: string,
  trustedImport: TrustedImport
): void {
  const fileName = resolve("/runtime-trust", `${label}.ts`);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    noResolve: true,
  };
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(options);
  host.fileExists = (path) => path === fileName;
  host.readFile = (path) => (path === fileName ? source : undefined);
  host.getSourceFile = (path) => (path === fileName ? sourceFile : undefined);
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  let importedSymbol: ts.Symbol | null = null;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== trustedImport.module
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find(
      (element) => (element.propertyName?.text ?? element.name.text) === trustedImport.symbol
    );
    if (imported && !statement.importClause?.isTypeOnly && !imported.isTypeOnly) {
      importedSymbol = checker.getSymbolAtLocation(imported.name) ?? null;
    }
  }
  if (!importedSymbol) throw new Error(`${label} does not import the exact runtime target`);

  let used = false;
  const isTypePosition = (node: ts.Node): boolean => {
    for (let current = node.parent; current && !ts.isStatement(current); current = current.parent) {
      if (ts.isTypeNode(current)) return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      checker.getSymbolAtLocation(node) === importedSymbol &&
      !isTypePosition(node)
    ) {
      used = true;
    }
    if (!used) ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) visit(statement);
  }
  if (!used) {
    throw new Error(`${label} does not use the exact runtime target`);
  }
}

export async function buildHostedRuntimeTrustReport(input: {
  repository: string;
  consumerCommit: string;
  target: unknown;
}): Promise<HostedRuntimeTrustReport> {
  if (!COMMIT.test(input.consumerCommit)) throw new Error("consumer commit is invalid");
  const target = exactTarget(input.target);
  if (JSON.stringify(canonicalValue(target)) !== JSON.stringify(canonicalValue(REVIEWED_TARGET))) {
    throw new Error("runtime target differs from the reviewed release pin");
  }
  const versionSlug = target.releaseVersion.replaceAll(".", "-");
  const fixtureIdentifier = `exomemContractFixture${versionSlug.replaceAll("-", "")}`;
  const root = resolve(input.repository);
  const agentPath = resolve(root, "src/lib/exomem-hosted/__tests__/agent-contract-fixture.json");
  const gatewayPath = resolve(
    root,
    `src/lib/exomem-hosted/__tests__/gateway-contract-${versionSlug}.json`
  );
  const agentBytes = committedBytes(root, input.consumerCommit, agentPath.slice(root.length + 1));
  const gatewayBytes = committedBytes(
    root,
    input.consumerCommit,
    gatewayPath.slice(root.length + 1)
  );
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
      name: "agent-canaries",
      path: "src/lib/exomem-hosted/agent-contract-canaries.ts",
      imports: [{ module: `./gateway-contract-${versionSlug}`, symbol: fixtureIdentifier }],
    },
    {
      name: "agent-contract-store",
      path: "src/lib/exomem-hosted/agent-contract-store.ts",
      imports: [{ module: "./agent-contract-fixture", symbol: "exomemHostedContractFixture" }],
    },
    {
      name: "client-artifacts",
      path: "src/lib/exomem-hosted/client-artifacts.ts",
      imports: [{ module: "./agent-contract-fixture", symbol: "exomemHostedContractFixture" }],
    },
    {
      name: "gateway-store",
      path: "src/lib/exomem-hosted/gateway.ts",
      imports: [
        { module: "./agent-contract-fixture", symbol: "exomemHostedContractFixture" },
        { module: `./gateway-contract-${versionSlug}`, symbol: fixtureIdentifier },
      ],
    },
    {
      name: "lifecycle-store",
      path: "src/lib/exomem-hosted/lifecycle-store.ts",
      imports: [{ module: `./gateway-contract-${versionSlug}`, symbol: fixtureIdentifier }],
    },
    {
      name: "reviewer-operator",
      path: "src/lib/exomem-hosted/operator-controls.ts",
      imports: [{ module: `./gateway-contract-${versionSlug}`, symbol: fixtureIdentifier }],
    },
  ];
  await Promise.all(
    sites.map(async (site) => {
      const source = committedBytes(root, input.consumerCommit, site.path).toString("utf8");
      for (const trustedImport of site.imports) {
        assertRuntimeTrustImport(source, site.name, trustedImport);
      }
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
