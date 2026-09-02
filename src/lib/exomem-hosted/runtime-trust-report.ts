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
// The ten-field output of `hosted_image_candidate.py verify` for Exomem v0.68.3,
// which checks the release's Sigstore attestation and cross-checks the agent and
// gateway fixtures against the signed candidate. Do not hand-assemble this.
const REVIEWED_TARGET: HostedRuntimeTrustTarget = {
  releaseVersion: "0.68.3",
  sourceCommit: "a35cd9e2f494a901b823c5037733bb758f48038a",
  runtimeImage:
    "ghcr.io/artexis10/exomem@sha256:f47e0fe9e21b2882d9ab531a574746b5c5facc57883cf9bc677e94a3d3d642d1",
  runtimeCandidateSha256: "47c893d1a19e6f2cb314596a9713a38ce06947db180478519a6b41c8afa51da2",
  protocolVersion: "1",
  agentProfile: "hosted-alpha-agent-v4",
  gatewayContractDigest: "e17bdc0c8f9ac738187923ba62ef5cf79b8c5f93c35b5f3eb8c1d4795f2f610b",
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
  root: ts.Node,
  predicate: (node: ts.Node) => node is T
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function hasTrustedReleaseEntry(root: ts.Node, target: HostedRuntimeTrustTarget): boolean {
  return descendants(root, ts.isArrayLiteralExpression).some((candidate) => {
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

type RuntimeTrustSource = {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
};

type RuntimeTrustBinding = {
  localName: string;
  symbol: ts.Symbol;
};

function runtimeTrustSource(source: string, label: string): RuntimeTrustSource {
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
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  return { sourceFile, checker };
}

function importedBinding(
  parsed: RuntimeTrustSource,
  module: string,
  exportedSymbol: string
): RuntimeTrustBinding {
  for (const statement of parsed.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== module
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const imported = bindings.elements.find(
      (entry) => (entry.propertyName?.text ?? entry.name.text) === exportedSymbol
    );
    const symbol = imported ? parsed.checker.getSymbolAtLocation(imported.name) : undefined;
    if (imported && symbol && !statement.importClause?.isTypeOnly && !imported.isTypeOnly) {
      return { localName: imported.name.text, symbol };
    }
  }
  throw new Error("exact runtime import is unavailable");
}

function topLevelVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  return null;
}

function topLevelFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  return (
    sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    ) ?? null
  );
}

function classMethod(
  sourceFile: ts.SourceFile,
  className: string,
  methodName: string
): ts.MethodDeclaration | null {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  return (
    declaration?.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === methodName
    ) ?? null
  );
}

function nodeUsesImportedProperties(
  root: ts.Node,
  checker: ts.TypeChecker,
  binding: RuntimeTrustBinding,
  properties: string[]
): boolean {
  const used = new Set<string>();
  for (const access of descendants(root, ts.isPropertyAccessExpression)) {
    if (
      ts.isIdentifier(access.expression) &&
      checker.getSymbolAtLocation(access.expression) === binding.symbol
    ) {
      used.add(access.name.text);
    }
  }
  return properties.every((property) => used.has(property));
}

function isImportedIdentifier(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  binding: RuntimeTrustBinding
): boolean {
  const value = unwrapExpression(expression);
  return ts.isIdentifier(value) && checker.getSymbolAtLocation(value) === binding.symbol;
}

function directFrozenCatalogEntries(initializer: ts.Expression): ts.ObjectLiteralExpression[] {
  const outer = unwrapExpression(initializer);
  if (!ts.isCallExpression(outer) || outer.arguments.length !== 1) return [];
  const array = unwrapExpression(outer.arguments[0]);
  if (!ts.isArrayLiteralExpression(array)) return [];
  return array.elements.flatMap((entry) => {
    if (ts.isSpreadElement(entry)) return [];
    const frozen = unwrapExpression(entry);
    if (!ts.isCallExpression(frozen) || frozen.arguments.length !== 1) return [];
    const object = unwrapExpression(frozen.arguments[0]);
    return ts.isObjectLiteralExpression(object) ? [object] : [];
  });
}

function objectPinsBindings(
  object: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  properties: Array<[string, RuntimeTrustBinding]>
): boolean {
  return properties.every(([name, binding]) =>
    object.properties.some(
      (entry) =>
        ts.isPropertyAssignment(entry) &&
        propertyName(entry.name) === name &&
        isImportedIdentifier(entry.initializer, checker, binding)
    )
  );
}

export function assertRuntimeTrustSitePin(
  source: string,
  label: string,
  target: HostedRuntimeTrustTarget
): void {
  const parsed = runtimeTrustSource(source, label);
  const { sourceFile, checker } = parsed;
  const versionSlug = target.releaseVersion.replaceAll(".", "-");
  const gatewayExport = `exomemContractFixture${target.releaseVersion.replaceAll(".", "")}`;
  const gatewayModule = `./gateway-contract-${versionSlug}`;
  let pinned = false;

  try {
    if (label === "agent-canaries") {
      const gateway = importedBinding(parsed, gatewayModule, gatewayExport);
      const catalog = topLevelVariable(sourceFile, "gatewayContractDigests")?.initializer;
      const production = topLevelFunction(sourceFile, "createCanaryAssignment");
      const key = `${gateway.localName}.release+":"+${gateway.localName}.protocol`;
      const catalogEntry =
        "[`${" +
        gateway.localName +
        ".release}:${" +
        gateway.localName +
        ".protocol}`," +
        gateway.localName +
        ".digest,]";
      const branch = `WHEN\${${key}}THEN\${gatewayContractDigests.get(${key})}`;
      pinned = Boolean(
        catalog &&
        production &&
        compact(catalog.getText(sourceFile)).includes(catalogEntry) &&
        nodeUsesImportedProperties(catalog, checker, gateway, ["release", "protocol", "digest"]) &&
        descendants(production, ts.isTaggedTemplateExpression).some(
          (template) =>
            compact(template.getText(sourceFile)).includes(branch) &&
            nodeUsesImportedProperties(template, checker, gateway, ["release", "protocol"])
        )
      );
    } else if (label === "agent-contract-store") {
      const agent = importedBinding(
        parsed,
        "./agent-contract-fixture",
        "exomemHostedContractFixture"
      );
      const catalog = topLevelVariable(sourceFile, "TRUSTED_RELEASES")?.initializer;
      const production = topLevelFunction(sourceFile, "storeExomemAgentContractCandidate");
      const currentCall = production
        ? descendants(production, ts.isCallExpression).some(
            (call) =>
              ts.isIdentifier(call.expression) &&
              call.expression.text === "checkedExomemAgentContractCandidate" &&
              call.arguments.length === 1 &&
              isImportedIdentifier(call.arguments[0], checker, agent)
          )
        : false;
      pinned = Boolean(catalog && currentCall && hasTrustedReleaseEntry(catalog, target));
    } else if (label === "client-artifacts") {
      const agent = importedBinding(
        parsed,
        "./agent-contract-fixture",
        "exomemHostedContractFixture"
      );
      const production = topLevelFunction(sourceFile, "loadClientArtifactLocks");
      pinned = Boolean(
        production &&
        descendants(production, ts.isConditionalExpression).some(
          (conditional) =>
            compact(conditional.condition.getText(sourceFile)) ===
              `row.source_release===${JSON.stringify(target.releaseVersion)}` &&
            isImportedIdentifier(conditional.whenTrue, checker, agent)
        )
      );
    } else if (label === "gateway-store") {
      const agent = importedBinding(
        parsed,
        "./agent-contract-fixture",
        "exomemHostedContractFixture"
      );
      const gateway = importedBinding(parsed, gatewayModule, gatewayExport);
      const catalog = topLevelVariable(sourceFile, "gatewayContractCatalog")?.initializer;
      pinned = Boolean(
        catalog &&
        directFrozenCatalogEntries(catalog).some((entry) =>
          objectPinsBindings(entry, checker, [
            ["full", gateway],
            ["agent", agent],
          ])
        )
      );
    } else if (label === "lifecycle-store") {
      const gateway = importedBinding(parsed, gatewayModule, gatewayExport);
      const key = `${gateway.localName}.release+":"+${gateway.localName}.protocol`;
      const branch = `WHEN\${${key}}THEN\${${gateway.localName}.digest}`;
      const requiredMethods: Array<[string, number]> = [
        ["enqueue", 2],
        ["#snapshotLegacyTarget", 1],
        ["#deriveLegacyTarget", 1],
      ];
      pinned = requiredMethods.every(([methodName, expectedBranches]) => {
        const method = classMethod(sourceFile, "SqlLifecycleStore", methodName);
        if (!method) return false;
        return (
          descendants(method, ts.isTaggedTemplateExpression).filter(
            (template) =>
              compact(template.getText(sourceFile)).includes(branch) &&
              nodeUsesImportedProperties(template, checker, gateway, [
                "release",
                "protocol",
                "digest",
              ])
          ).length === expectedBranches
        );
      });
    } else if (label === "reviewer-operator") {
      const gateway = importedBinding(parsed, gatewayModule, gatewayExport);
      const production = topLevelFunction(sourceFile, "createReviewerOAuthBootstrapAuthority");
      pinned = Boolean(
        production &&
        descendants(production, ts.isTaggedTemplateExpression).some((template) => {
          const text = compact(template.getText(sourceFile));
          return (
            text.includes(`candidate.source_release=\${${gateway.localName}.release}`) &&
            text.includes(`candidate.protocol_version=\${${gateway.localName}.protocol}`) &&
            text.includes(`\${${gateway.localName}.digest}`) &&
            nodeUsesImportedProperties(template, checker, gateway, [
              "release",
              "protocol",
              "digest",
            ])
          );
        })
      );
    }
  } catch {
    pinned = false;
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
