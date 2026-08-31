#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ListToolsResultSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";

const RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";
const RELEASES = {
  "253c9aa365d7afd8829dc7843f1cac53353ac825": {
    sourceRelease: "0.34.0",
    archiveSha256: "ca5cac5ada03c02642b64906acb2dfad2faeda3d25eb7110446c55b213cd32c9",
  },
  d4c5614e5f65d8bcbddee90e9e374846c5a2c22f: {
    sourceRelease: "0.35.0",
  },
  "4e9ba9caabcee985e3371320803c11946cd40cc6": {
    sourceRelease: "0.39.2",
  },
  d6ea0c11224331fb27a45b485091399679e59bbf: {
    sourceRelease: "0.49.0",
  },
  "9c862c2bd851cf72921a545239ae5c8b45594c31": {
    sourceRelease: "0.50.0",
  },
  b41906384ac187cc4877abfc204639fb3b6f8d48: {
    sourceRelease: "0.54.1",
  },
  d4bbef7725d55f3bb6e8c288deadddb15ef7855f: {
    sourceRelease: "0.57.2",
  },
  "35f6d7bb92a79f9d59f82e8e87557fd0e68fb3e5": {
    sourceRelease: "0.63.1",
    profile: "hosted-alpha-agent-v4",
    generatedDirectory: "plugins/hosted/generated/candidates/hosted-alpha-agent-v4",
    openai: true,
    packageZipOnlyPaths: [".mcp.json"],
  },
  efd6e15f40221bb3821f979d6fcbda45e7c6a649: {
    sourceRelease: "0.66.0",
    profile: "hosted-alpha-agent-v4",
    generatedDirectory: "plugins/hosted/generated/candidates/hosted-alpha-agent-v4",
    openai: true,
    // No packageZipOnlyPaths: 0.63.1 shipped `.mcp.json` inside the ZIP without
    // tracking it, so the zip-only set was non-empty. Exomem #907 tracks both
    // platforms' `.mcp.json`, so every ZIP entry now has a committed twin.
  },
  "76571f2c9f600395344a2a62efe6aca36d32b42d": {
    sourceRelease: "0.68.0",
    profile: "hosted-alpha-agent-v4",
    generatedDirectory: "plugins/hosted/generated/candidates/hosted-alpha-agent-v4",
    openai: true,
  },
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) fail("arguments must be --name value pairs");
    values.set(name.slice(2), value);
  }
  return values;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be SHA-256`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function readJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} must be readable JSON`);
  }
}

function gitBlob(repo, commit, path) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], { cwd: repo });
  } catch {
    fail(`missing committed Exomem artifact: ${path}`);
  }
}

function tarEntries(archive) {
  const files = new Map();
  let offset = 0;
  let commit = "";
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size =
      Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) ||
      0;
    if (!name) break;
    const body = archive.subarray(offset + 512, offset + 512 + size);
    if (name === "pax_global_header") {
      const match = body.toString("utf8").match(/comment=([0-9a-f]{40})/);
      if (match) commit = match[1];
    } else if (!name.endsWith("/")) {
      if (name.startsWith("/")) fail("unsafe exact-commit archive path");
      files.set(name, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { files, commit };
}

function zipEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from("PK\x05\x06"));
  if (end < 0) fail("generated archive has no ZIP directory");
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (bytes.subarray(offset, offset + 4).toString("binary") !== "PK\x01\x02")
      fail("generated archive has an invalid ZIP entry");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString("utf8");
    if (!name || name.startsWith("/") || name.includes("..") || files.has(name))
      fail("generated archive has an unsafe ZIP path");
    if (bytes.subarray(localOffset, localOffset + 4).toString("binary") !== "PK\x03\x04")
      fail("generated archive has an invalid local ZIP entry");
    const localNameSize = bytes.readUInt16LE(localOffset + 26);
    const localExtraSize = bytes.readUInt16LE(localOffset + 28);
    const body = bytes.subarray(
      localOffset + 30 + localNameSize + localExtraSize,
      localOffset + 30 + localNameSize + localExtraSize + compressedSize
    );
    files.set(
      name,
      method === 0
        ? Buffer.from(body)
        : method === 8
          ? inflateRawSync(body)
          : fail("generated archive uses an unsupported ZIP compression")
    );
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return files;
}

function packageDigest(entries) {
  return canonicalSha256(
    [...entries.entries()]
      .map(([path, contents]) => [path, createHash("sha256").update(contents).digest("hex")])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

const args = argumentsFrom(process.argv.slice(2));
const repoArg = args.get("exomem-repo");
const outputArg = args.get("output");
const jsonOutputArg = args.get("json-output");
const gatewayOutputArg = args.get("gateway-output");
const gatewayJsonOutputArg = args.get("gateway-json-output");
const archiveArg = args.get("archive-file");
const expectedCommit = args.get("expected-commit") ?? "";
const sourceRelease = args.get("source-release") ?? "";
if (
  !repoArg ||
  !outputArg ||
  !jsonOutputArg ||
  !/^[0-9a-f]{40}$/.test(expectedCommit) ||
  !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(sourceRelease)
) {
  fail(
    "required: --exomem-repo PATH --output PATH --json-output PATH --expected-commit FULL_SHA --source-release VERSION"
  );
}
const release = RELEASES[expectedCommit];
if (!release || release.sourceRelease !== sourceRelease)
  fail("generator only accepts a pinned Exomem release and its exact source release");
const profile = release.profile ?? "hosted-alpha-agent-v1";
if (Boolean(gatewayOutputArg) !== Boolean(gatewayJsonOutputArg))
  fail("full gateway output requires both --gateway-output and --gateway-json-output");
const repo = resolve(repoArg);
const output = resolve(outputArg);
const jsonOutput = resolve(jsonOutputArg);
const gatewayOutput = gatewayOutputArg ? resolve(gatewayOutputArg) : null;
const gatewayJsonOutput = gatewayJsonOutputArg ? resolve(gatewayJsonOutputArg) : null;
const archiveBytes = archiveArg ? readFileSync(resolve(archiveArg)) : null;
if (
  archiveBytes &&
  (!release.archiveSha256 ||
    createHash("sha256").update(archiveBytes).digest("hex") !== release.archiveSha256)
) {
  fail("archive does not match the reviewed pinned SHA-256");
}
const archive = archiveBytes ? tarEntries(archiveBytes) : null;
if (!archive) {
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  if (actualCommit !== expectedCommit) fail("Exomem checkout is not at the selected commit");
  if (
    execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() !== ""
  ) {
    fail("Exomem checkout must be clean before generating a release fixture");
  }
}
if (archive && archive.commit !== expectedCommit)
  fail("archive does not prove the pinned Exomem commit");
const sourceBlob = (path) =>
  archive
    ? (archive.files.get(path) ?? fail(`archive is missing ${path}`))
    : gitBlob(repo, expectedCommit, path);

function pythonExecutable(sourceRepo) {
  const candidates =
    process.platform === "win32"
      ? [join(sourceRepo, ".venv", "Scripts", "python.exe"), "python"]
      : [join(sourceRepo, ".venv", "bin", "python"), "python3", "python"];
  return candidates.find(
    (candidate) => candidate === "python" || candidate === "python3" || existsSync(candidate)
  );
}

function generatedFullGatewayContract() {
  if (archive) fail("full gateway fixture generation requires a clean Exomem checkout");
  const python = pythonExecutable(repo);
  if (!python) fail("Exomem checkout has no Python executable for full gateway generation");
  let bytes;
  try {
    bytes = execFileSync(
      python,
      [
        "-c",
        "import json; from exomem.hosted_gateway import build_gateway_contract; print(json.dumps(build_gateway_contract(), sort_keys=True))",
      ],
      { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, "src") } }
    );
  } catch {
    fail("could not build the full private gateway contract from the pinned Exomem checkout");
  }
  return object(readJson(bytes, "full gateway contract"), "full gateway contract");
}

function gatewayFixture(value) {
  const digest = object(value.digest, "full gateway contract digest");
  if (
    value.schema_version !== 1 ||
    value.exomem_release !== sourceRelease ||
    typeof value.protocol_version !== "string" ||
    digest.algorithm !== "sha256" ||
    !Array.isArray(value.commands)
  ) {
    fail("full gateway contract has an invalid release identity");
  }
  const unsigned = { ...value };
  delete unsigned.digest;
  if (canonicalSha256(unsigned) !== sha256(digest.value, "full gateway contract digest"))
    fail("full gateway contract digest does not match committed content");
  const commands = value.commands.map((raw) => {
    const command = object(raw, "full gateway command");
    if (
      typeof command.name !== "string" ||
      typeof command.read_only !== "boolean" ||
      (command.mode !== "read" && command.mode !== "write") ||
      command.read_only !== (command.mode === "read") ||
      !Number.isInteger(command.tier) ||
      typeof command.capability !== "string" ||
      !Array.isArray(command.params) ||
      !Array.isArray(command.guarded_fields)
    ) {
      fail("full gateway contract has an invalid semantic command");
    }
    return [
      command.name,
      command.read_only,
      command.mode,
      command.tier,
      command.capability,
      command.params.map((rawParameter) => {
        const parameter = object(rawParameter, "full gateway parameter");
        if (
          typeof parameter.name !== "string" ||
          typeof parameter.type !== "string" ||
          typeof parameter.required !== "boolean"
        ) {
          fail("full gateway contract has an invalid semantic parameter");
        }
        return [parameter.name, parameter.type, parameter.required];
      }),
      command.guarded_fields,
    ];
  });
  return {
    sourceCommit: expectedCommit,
    release: sourceRelease,
    protocol: value.protocol_version,
    digest: digest.value,
    commands,
  };
}

const generated = release.generatedDirectory ?? "plugins/hosted/generated";
const compatibility = object(
  readJson(sourceBlob(`${generated}/compatibility.json`), "compatibility artifact"),
  "compatibility artifact"
);
const agentContract = object(compatibility.agent_contract, "agent contract");
const agentProfile = object(agentContract.agent_profile, "agent profile");
const digest = object(agentContract.digest, "agent contract digest");
const packageLock = object(
  readJson(sourceBlob(`${generated}/claude.lock.json`), "Claude package lock"),
  "Claude package lock"
);
const archiveLock = object(
  readJson(sourceBlob(`${generated}/claude.zip.lock.json`), "Claude archive lock"),
  "Claude archive lock"
);
const openaiPackageLock = release.openai
  ? object(
      readJson(sourceBlob(`${generated}/openai.lock.json`), "OpenAI package lock"),
      "OpenAI package lock"
    )
  : null;
const openaiArchiveLock = release.openai
  ? object(
      readJson(sourceBlob(`${generated}/openai.zip.lock.json`), "OpenAI archive lock"),
      "OpenAI archive lock"
    )
  : null;
if (
  compatibility.schema_version !== 1 ||
  compatibility.profile !== profile ||
  compatibility.endpoint !== RESOURCE ||
  agentProfile.profile !== profile ||
  agentContract.protocol_version !== "1" ||
  digest.algorithm !== "sha256" ||
  sha256(digest.value, "agent contract digest") !==
    sha256(compatibility.schema_contract_sha256, "schema digest") ||
  sha256(agentProfile.active_capability_sha256, "profile fingerprint") !==
    sha256(compatibility.command_surface_sha256, "command fingerprint") ||
  !Array.isArray(agentContract.commands) ||
  agentContract.commands.length === 0
) {
  fail("compatibility artifact has an invalid Hosted agent identity");
}
const mcpTools = [];
for (const command of agentContract.commands) {
  const raw = object(command, "agent command");
  const tool = object(raw.mcp_tool, "raw MCP tool");
  if (
    typeof raw.name !== "string" ||
    raw.name !== tool.name ||
    typeof tool.description !== "string" ||
    !object(tool.inputSchema, "raw MCP input schema") ||
    !object(tool.annotations, "raw MCP annotations")
  ) {
    fail("compatibility artifact has an incomplete raw MCP tool");
  }
  if (!ToolSchema.safeParse(tool).success)
    fail("compatibility artifact has an SDK-invalid raw MCP tool");
  mcpTools.push(tool);
}
if (!ListToolsResultSchema.safeParse({ tools: mcpTools }).success) {
  fail("compatibility artifact has an SDK-invalid MCP tools/list result");
}
const rootCommands = compatibility.commands;
const agentCommandNames = agentContract.commands.map((command) => command.name);
if (
  !Array.isArray(rootCommands) ||
  !rootCommands.every((name) => typeof name === "string") ||
  new Set(rootCommands).size !== rootCommands.length ||
  JSON.stringify(rootCommands) !== JSON.stringify(agentCommandNames)
) {
  fail("root command ordering does not exactly match the imported agent contract");
}
const profileFingerprint = canonicalSha256({
  surface: agentProfile.surface,
  profile: agentProfile.profile,
  tier2_policy: agentProfile.tier2_policy,
  available_product_tools: agentProfile.available_product_tools,
  exported_aliases: agentProfile.exported_aliases,
  hand_registered_tools: agentProfile.hand_registered_tools,
});
if (
  profileFingerprint !== agentProfile.active_capability_sha256 ||
  agentProfile.immutable !== true
) {
  fail("agent profile fingerprint does not match committed profile metadata");
}
const contractBase = { ...agentContract };
delete contractBase.digest;
if (canonicalSha256(contractBase) !== digest.value)
  fail("agent contract schema digest does not match its raw schema");
const compatibilityBase = { ...compatibility };
delete compatibilityBase.compatibility_sha256;
if (canonicalSha256(compatibilityBase) !== compatibility.compatibility_sha256)
  fail("compatibility digest does not match committed content");
for (const [key, expected] of Object.entries({
  endpoint: RESOURCE,
  profile,
  command_surface_sha256: compatibility.command_surface_sha256,
  schema_contract_sha256: compatibility.schema_contract_sha256,
  compatibility_sha256: compatibility.compatibility_sha256,
  definition_sha256: compatibility.definition_sha256,
  skills_sha256: compatibility.skills_sha256,
  oauth_discovery_sha256: compatibility.oauth_discovery_sha256,
  plugin_id: compatibility.plugin_id,
  plugin_version: compatibility.plugin_version,
}))
  if (packageLock[key] !== expected) fail(`Claude package lock differs for ${key}`);
if (packageLock.platform !== "claude" || archiveLock.platform !== "claude")
  fail("Claude lock platform is invalid");
sha256(packageLock.artifact_sha256, "Claude package artifact digest");
sha256(archiveLock.archive_sha256, "Claude archive digest");
function verifyPlatform(platform, platformPackageLock, platformArchiveLock) {
  for (const [key, expected] of Object.entries({
    endpoint: RESOURCE,
    profile,
    command_surface_sha256: compatibility.command_surface_sha256,
    schema_contract_sha256: compatibility.schema_contract_sha256,
    compatibility_sha256: compatibility.compatibility_sha256,
    definition_sha256: compatibility.definition_sha256,
    skills_sha256: compatibility.skills_sha256,
    oauth_discovery_sha256: compatibility.oauth_discovery_sha256,
    plugin_id: compatibility.plugin_id,
    plugin_version: compatibility.plugin_version,
  })) {
    if (platformPackageLock[key] !== expected) fail(`${platform} package lock differs for ${key}`);
  }
  if (platformPackageLock.platform !== platform || platformArchiveLock.platform !== platform)
    fail(`${platform} lock platform is invalid`);
  sha256(platformPackageLock.artifact_sha256, `${platform} package artifact digest`);
  sha256(platformArchiveLock.archive_sha256, `${platform} archive digest`);
  if (
    platform === "openai" &&
    sha256(platformPackageLock.registered_app_id_sha256, "OpenAI registered app ID digest") !==
      sha256(platformArchiveLock.registered_app_id_sha256, "OpenAI registered app ID digest")
  ) {
    fail("OpenAI locks have different registered app ID digests");
  }
  const zipped = zipEntries(sourceBlob(`${generated}/${platform}.zip`));
  if (
    packageDigest(zipped) !== platformPackageLock.artifact_sha256 ||
    createHash("sha256")
      .update(sourceBlob(`${generated}/${platform}.zip`))
      .digest("hex") !== platformArchiveLock.archive_sha256
  ) {
    fail(`${platform} package or archive bytes do not match their lock`);
  }
  const packageEntries = archive
    ? [...archive.files.entries()]
        .filter(([path]) => path.startsWith(`${generated}/${platform}/`))
        .map(([path, body]) => [path.slice(`${generated}/${platform}/`.length), body])
    : execFileSync(
        "git",
        ["ls-tree", "-r", "-z", expectedCommit, "--", `${generated}/${platform}`],
        { cwd: repo }
      )
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const [, , path] = /^(?:\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry) ?? [];
          if (!path) fail("invalid committed package tree entry");
          return [
            path.slice(`${generated}/${platform}/`.length),
            gitBlob(repo, expectedCommit, path),
          ];
        });
  const committedPaths = new Set(packageEntries.map(([path]) => path));
  const zipOnlyPaths = [...zipped.keys()].filter((path) => !committedPaths.has(path));
  if (
    JSON.stringify(zipOnlyPaths.sort()) !==
      JSON.stringify([...(release.packageZipOnlyPaths ?? [])].sort()) ||
    packageEntries.some(([path, body]) => !zipped.get(path)?.equals(body))
  ) {
    fail(`${platform} ZIP entries differ from the committed package tree`);
  }
}
verifyPlatform("claude", packageLock, archiveLock);
if (openaiPackageLock && openaiArchiveLock)
  verifyPlatform("openai", openaiPackageLock, openaiArchiveLock);

const fixture = {
  sourceCommit: expectedCommit,
  sourceRelease,
  compatibility,
  packageLock,
  archiveLock,
  ...(openaiPackageLock && openaiArchiveLock ? { openaiPackageLock, openaiArchiveLock } : {}),
};
const json = `${JSON.stringify(fixture, null, 2)}\n`;
const source = `// Generated from Exomem compatibility.json at commit ${expectedCommit} for cell release ${sourceRelease}. Do not edit.\nexport const exomemHostedContractFixture = ${JSON.stringify(fixture, null, 2)} as const;\n`;
writeFileSync(output, source, { encoding: "utf8", mode: 0o644 });
writeFileSync(jsonOutput, json, { encoding: "utf8", mode: 0o644 });
if (gatewayOutput && gatewayJsonOutput) {
  const fullContract = generatedFullGatewayContract();
  const fullFixture = gatewayFixture(fullContract);
  const gatewaySource = `// Generated from Exomem ${sourceRelease} commit ${expectedCommit} build_gateway_contract(); semantic fields only. Do not edit.\nexport type ExomemContractCommandFixture = readonly [\n  name: string,\n  readOnly: boolean,\n  mode: "read" | "write",\n  tier: number,\n  capability: string,\n  params: readonly (readonly [name: string, type: string, required: boolean])[],\n  guardedFields: readonly string[],\n];\n\nconst commands = ${JSON.stringify(fullFixture.commands, null, 2)} as const satisfies readonly ExomemContractCommandFixture[];\n\nexport const exomemContractFixture${sourceRelease.replaceAll(".", "")} = {\n  sourceCommit: ${JSON.stringify(fullFixture.sourceCommit)},\n  release: ${JSON.stringify(fullFixture.release)},\n  protocol: ${JSON.stringify(fullFixture.protocol)},\n  digest: ${JSON.stringify(fullFixture.digest)},\n  commands,\n} as const;\n`;
  writeFileSync(gatewayOutput, gatewaySource, { encoding: "utf8", mode: 0o644 });
  writeFileSync(gatewayJsonOutput, `${JSON.stringify(fullContract, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}
