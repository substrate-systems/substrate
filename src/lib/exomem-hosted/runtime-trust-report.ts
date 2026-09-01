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
// The ten-field output of `hosted_image_candidate.py verify` for Exomem v0.68.1,
// which checks the release's Sigstore attestation and cross-checks the agent and
// gateway fixtures against the signed candidate. Do not hand-assemble this.
const REVIEWED_TARGET: HostedRuntimeTrustTarget = {
  releaseVersion: "0.68.1",
  sourceCommit: "e487efa2fdfd8c7653b6e99605163a0200c6ce58",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:9870b3f661969a70504fb4ccad60b6429c21c13732f754d0e8aef030e3277246",
  runtimeCandidateSha256: "6743cf711b08cf8b64a7db8a62ce06f4a9246e59cc54a76f23c102959fc10aa9",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v4",
  gatewayContractDigest: "2af163baf368643f41d7fa4eaa0c3d2d0f2ead54443fd0263d2977dc4094a469",
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error("TypeScript fixture has a computed property");
}

function literalValue(expression: ts.Expression, bindings: Map<string, unknown>): unknown {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNumericLiteral(value)) {
    return ts.isNumericLiteral(value) ? Number(value.text) : value.text;
  }
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(value) && bindings.has(value.text)) return bindings.get(value.text);
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((entry) => {
      if (ts.isSpreadElement(entry)) throw new Error("TypeScript fixture contains a spread");
      return literalValue(entry, bindings);
    });
  }
  if (ts.isObjectLiteralExpression(value)) {
    const result: JsonRecord = {};
    for (const entry of value.properties) {
      if (ts.isPropertyAssignment(entry)) {
        result[propertyName(entry.name)] = literalValue(entry.initializer, bindings);
      } else if (ts.isShorthandPropertyAssignment(entry) && bindings.has(entry.name.text)) {
        result[entry.name.text] = bindings.get(entry.name.text);
      } else {
        throw new Error("TypeScript fixture contains a non-literal property");
      }
    }
    return result;
  }
  throw new Error("TypeScript fixture contains a non-literal expression");
}

function fixtureBinding(source: string, name: string): unknown {
  const sourceFile = ts.createSourceFile(
    resolve("/runtime-trust", `${name}.ts`),
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const bindings = new Map<string, unknown>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      bindings.set(declaration.name.text, literalValue(declaration.initializer, bindings));
    }
  }
  if (!bindings.has(name)) throw new Error(`TypeScript fixture is missing ${name}`);
  return bindings.get(name);
}

function gatewayCommandProjection(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("gateway fixture commands must be an array");
  return value.map((entry, index) => {
    const command = record(entry, `gateway command ${index}`);
    if (!Array.isArray(command.params) || !Array.isArray(command.guarded_fields)) {
      throw new Error(`gateway command ${index} is invalid`);
    }
    return [
      command.name,
      command.read_only,
      command.mode,
      command.tier,
      command.capability,
      command.params.map((parameter, parameterIndex) => {
        const param = record(parameter, `gateway command ${index} parameter ${parameterIndex}`);
        return [param.name, param.type, param.required];
      }),
      command.guarded_fields,
    ];
  });
}

export function assertRuntimeTrustFixtureProjection(input: {
  agentTypeScript: string;
  agentJson: unknown;
  gatewayTypeScript: string;
  gatewayJson: unknown;
  target: HostedRuntimeTrustTarget;
}): void {
  const agentFixture = fixtureBinding(input.agentTypeScript, "exomemHostedContractFixture");
  if (
    JSON.stringify(canonicalValue(agentFixture)) !== JSON.stringify(canonicalValue(input.agentJson))
  ) {
    throw new Error("TypeScript agent fixture differs from the reviewed JSON projection");
  }

  const gateway = record(input.gatewayJson, "gateway fixture");
  const gatewayDigest = record(gateway.digest, "gateway fixture digest");
  const expectedGatewayFixture = {
    sourceCommit: input.target.sourceCommit,
    release: gateway.exomem_release,
    protocol: gateway.protocol_version,
    digest: gatewayDigest.value,
    commands: gatewayCommandProjection(gateway.commands),
  };
  const gatewayIdentifier = `exomemContractFixture${input.target.releaseVersion.replaceAll(".", "")}`;
  const gatewayFixture = fixtureBinding(input.gatewayTypeScript, gatewayIdentifier);
  if (
    JSON.stringify(canonicalValue(gatewayFixture)) !==
    JSON.stringify(canonicalValue(expectedGatewayFixture))
  ) {
    throw new Error("TypeScript gateway fixture differs from the reviewed JSON projection");
  }
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function descendants<T extends ts.Node>(
  sourceFile: ts.SourceFile,
  predicate: (node: ts.Node) => node is T
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

function hasTrustedReleaseEntry(
  sourceFile: ts.SourceFile,
  target: HostedRuntimeTrustTarget
): boolean {
  return descendants(sourceFile, ts.isArrayLiteralExpression).some((candidate) => {
    if (
      candidate.elements.length !== 2 ||
      !ts.isStringLiteral(candidate.elements[0]) ||
      candidate.elements[0].text !== target.releaseVersion ||
      !ts.isObjectLiteralExpression(candidate.elements[1])
    ) {
      return false;
    }
    try {
      const trusted = record(literalValue(candidate.elements[1], new Map()), "trusted release");
      return (
        trusted.sourceCommit === target.sourceCommit &&
        trusted.command_surface_sha256 === target.commandFingerprint &&
        trusted.schema_contract_sha256 === target.schemaDigest &&
        trusted.compatibility_sha256 === target.compatibilityDigest
      );
    } catch {
      return false;
    }
  });
}

export function assertRuntimeTrustSitePin(
  source: string,
  label: string,
  target: HostedRuntimeTrustTarget
): void {
  const sourceFile = ts.createSourceFile(
    resolve("/runtime-trust", `${label}.ts`),
    source,
    ts.ScriptTarget.Latest,
    true
  );
  const taggedTemplates = descendants(sourceFile, ts.isTaggedTemplateExpression).map((node) =>
    compact(node.getText(sourceFile))
  );
  let pinned = false;

  if (label === "agent-canaries") {
    const key = 'exomemContractFixture0681.release+":"+exomemContractFixture0681.protocol';
    pinned = taggedTemplates.some((text) =>
      text.includes(`WHEN\${${key}}THEN\${gatewayContractDigests.get(${key})}`)
    );
  } else if (label === "agent-contract-store") {
    const currentFunction = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "storeExomemAgentContractCandidate"
    );
    pinned = Boolean(
      currentFunction &&
      compact(currentFunction.getText(sourceFile)).includes(
        "checkedExomemAgentContractCandidate(exomemHostedContractFixture)"
      ) &&
      hasTrustedReleaseEntry(sourceFile, target)
    );
  } else if (label === "client-artifacts") {
    pinned = descendants(sourceFile, ts.isConditionalExpression).some(
      (conditional) =>
        compact(conditional.condition.getText(sourceFile)) ===
          `row.source_release===${JSON.stringify(target.releaseVersion)}` &&
        compact(conditional.whenTrue.getText(sourceFile)) === "exomemHostedContractFixture0681"
    );
  } else if (label === "gateway-store") {
    pinned = descendants(sourceFile, ts.isObjectLiteralExpression).some((object) => {
      const entries = new Map(
        object.properties.flatMap((entry) =>
          ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name)
            ? [[entry.name.text, compact(entry.initializer.getText(sourceFile))] as const]
            : []
        )
      );
      return (
        entries.get("full") === "exomemContractFixture0681" &&
        entries.get("agent") === "agentFixture0681"
      );
    });
  } else if (label === "lifecycle-store") {
    const key = 'exomemContractFixture0681.release+":"+exomemContractFixture0681.protocol';
    const branch = `WHEN\${${key}}THEN\${exomemContractFixture0681.digest}`;
    pinned = taggedTemplates.filter((text) => text.includes(branch)).length === 4;
  } else if (label === "reviewer-operator") {
    pinned = taggedTemplates.some(
      (text) =>
        text.includes("candidate.source_release=\${exomemContractFixture0681.release}") &&
        text.includes("candidate.protocol_version=\${exomemContractFixture0681.protocol}") &&
        text.includes("\${exomemContractFixture0681.digest}")
    );
  }

  if (!pinned) throw new Error(`${label} does not pin the exact runtime target`);
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
  const agentTypeScriptPath = resolve(root, "src/lib/exomem-hosted/agent-contract-fixture.ts");
  const gatewayPath = resolve(
    root,
    `src/lib/exomem-hosted/__tests__/gateway-contract-${versionSlug}.json`
  );
  const gatewayTypeScriptPath = resolve(
    root,
    `src/lib/exomem-hosted/gateway-contract-${versionSlug}.ts`
  );
  const agentBytes = committedBytes(root, input.consumerCommit, agentPath.slice(root.length + 1));
  const agentTypeScriptBytes = committedBytes(
    root,
    input.consumerCommit,
    agentTypeScriptPath.slice(root.length + 1)
  );
  const gatewayBytes = committedBytes(
    root,
    input.consumerCommit,
    gatewayPath.slice(root.length + 1)
  );
  const gatewayTypeScriptBytes = committedBytes(
    root,
    input.consumerCommit,
    gatewayTypeScriptPath.slice(root.length + 1)
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
  assertRuntimeTrustFixtureProjection({
    agentTypeScript: agentTypeScriptBytes.toString("utf8"),
    agentJson: agent,
    gatewayTypeScript: gatewayTypeScriptBytes.toString("utf8"),
    gatewayJson: gateway,
    target,
  });

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
      assertRuntimeTrustSitePin(source, site.name, target);
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
