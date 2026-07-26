#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const PROFILE = "hosted-alpha-agent-v1";
const RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";
const RELEASE_COMMIT = "529760e1cd955ea999c6a7f836d7a1504327eae7";

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
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be SHA-256`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
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
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) || 0;
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
    if (bytes.subarray(offset, offset + 4).toString("binary") !== "PK\x01\x02") fail("generated archive has an invalid ZIP entry");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString("utf8");
    if (!name || name.startsWith("/") || name.includes("..") || files.has(name)) fail("generated archive has an unsafe ZIP path");
    if (bytes.subarray(localOffset, localOffset + 4).toString("binary") !== "PK\x03\x04") fail("generated archive has an invalid local ZIP entry");
    const localNameSize = bytes.readUInt16LE(localOffset + 26);
    const localExtraSize = bytes.readUInt16LE(localOffset + 28);
    const body = bytes.subarray(localOffset + 30 + localNameSize + localExtraSize, localOffset + 30 + localNameSize + localExtraSize + compressedSize);
    files.set(name, method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : fail("generated archive uses an unsupported ZIP compression"));
    offset += 46 + nameSize + extraSize + commentSize;
  }
  return files;
}

function packageDigest(repo, commit, packagePath) {
  if (archive) {
    const entries = [...archive.files.entries()]
      .filter(([path]) => path.startsWith(`${packagePath}/`))
      .map(([path, contents]) => [path.slice(`${packagePath}/`.length), createHash("sha256").update(contents).digest("hex")])
      .sort(([left], [right]) => left.localeCompare(right));
    if (!entries.length) fail("committed package tree is empty");
    return canonicalSha256(entries);
  }
  const listing = execFileSync("git", ["ls-tree", "-r", "-z", commit, "--", packagePath], { cwd: repo });
  const entries = listing.toString("utf8").split("\0").filter(Boolean).map((entry) => {
    const [, blob, path] = /^(?:\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry) ?? [];
    if (!blob || !path) fail("invalid committed package tree entry");
    const relative = path.slice(`${packagePath}/`.length);
    return [relative, createHash("sha256").update(gitBlob(repo, commit, path)).digest("hex")];
  });
  if (!entries.length) fail("committed package tree is empty");
  return canonicalSha256(entries);
}

const args = argumentsFrom(process.argv.slice(2));
const repoArg = args.get("exomem-repo");
const outputArg = args.get("output");
const jsonOutputArg = args.get("json-output");
const archiveArg = args.get("archive-file");
const expectedCommit = args.get("expected-commit") ?? "";
if (!repoArg || !outputArg || !jsonOutputArg || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
  fail("required: --exomem-repo PATH --output PATH --json-output PATH --expected-commit FULL_SHA");
}
if (expectedCommit !== RELEASE_COMMIT) fail("generator only accepts the pinned Exomem release commit");
const repo = resolve(repoArg);
const output = resolve(outputArg);
const jsonOutput = resolve(jsonOutputArg);
const archive = archiveArg ? tarEntries(readFileSync(resolve(archiveArg))) : null;
if (!archive) {
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  if (actualCommit !== expectedCommit) fail("Exomem checkout is not at the selected commit");
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() !== "") {
    fail("Exomem checkout must be clean before generating a release fixture");
  }
}
if (archive && archive.commit !== expectedCommit) fail("archive does not prove the pinned Exomem commit");
const sourceBlob = (path) => archive ? (archive.files.get(path) ?? fail(`archive is missing ${path}`)) : gitBlob(repo, expectedCommit, path);

const generated = "plugins/hosted/generated";
const compatibility = object(readJson(sourceBlob(`${generated}/compatibility.json`), "compatibility artifact"), "compatibility artifact");
const agentContract = object(compatibility.agent_contract, "agent contract");
const agentProfile = object(agentContract.agent_profile, "agent profile");
const digest = object(agentContract.digest, "agent contract digest");
const packageLock = object(readJson(sourceBlob(`${generated}/claude.lock.json`), "Claude package lock"), "Claude package lock");
const archiveLock = object(readJson(sourceBlob(`${generated}/claude.zip.lock.json`), "Claude archive lock"), "Claude archive lock");
if (compatibility.schema_version !== 1 || compatibility.profile !== PROFILE || compatibility.endpoint !== RESOURCE ||
    agentProfile.profile !== PROFILE || agentContract.protocol_version !== "1" || digest.algorithm !== "sha256" ||
    sha256(digest.value, "agent contract digest") !== sha256(compatibility.schema_contract_sha256, "schema digest") ||
    sha256(agentProfile.active_capability_sha256, "profile fingerprint") !== sha256(compatibility.command_surface_sha256, "command fingerprint") ||
    !Array.isArray(agentContract.commands) || agentContract.commands.length === 0) {
  fail("compatibility artifact has an invalid Hosted agent identity");
}
for (const command of agentContract.commands) {
  const raw = object(command, "agent command");
  const tool = object(raw.mcp_tool, "raw MCP tool");
  if (typeof raw.name !== "string" || raw.name !== tool.name || typeof tool.description !== "string" ||
      !object(tool.inputSchema, "raw MCP input schema") || !object(tool.annotations, "raw MCP annotations")) {
    fail("compatibility artifact has an incomplete raw MCP tool");
  }
}
const rootCommands = compatibility.commands;
const agentCommandNames = agentContract.commands.map((command) => command.name);
if (!Array.isArray(rootCommands) || !rootCommands.every((name) => typeof name === "string") ||
    new Set(rootCommands).size !== rootCommands.length || JSON.stringify(rootCommands) !== JSON.stringify(agentCommandNames)) {
  fail("root command ordering does not exactly match the imported agent contract");
}
const profileFingerprint = canonicalSha256({
  surface: agentProfile.surface, profile: agentProfile.profile, tier2_policy: agentProfile.tier2_policy,
  available_product_tools: agentProfile.available_product_tools, exported_aliases: agentProfile.exported_aliases,
  hand_registered_tools: agentProfile.hand_registered_tools,
});
if (profileFingerprint !== agentProfile.active_capability_sha256 || agentProfile.immutable !== true) {
  fail("agent profile fingerprint does not match committed profile metadata");
}
const { digest: _contractDigest, ...contractBase } = agentContract;
if (canonicalSha256(contractBase) !== digest.value) fail("agent contract schema digest does not match its raw schema");
const { compatibility_sha256: _compatibilityDigest, ...compatibilityBase } = compatibility;
if (canonicalSha256(compatibilityBase) !== compatibility.compatibility_sha256) fail("compatibility digest does not match committed content");
for (const [key, expected] of Object.entries({
  endpoint: RESOURCE, profile: PROFILE,
  command_surface_sha256: compatibility.command_surface_sha256,
  schema_contract_sha256: compatibility.schema_contract_sha256,
  compatibility_sha256: compatibility.compatibility_sha256,
  definition_sha256: compatibility.definition_sha256,
  skills_sha256: compatibility.skills_sha256,
  oauth_discovery_sha256: compatibility.oauth_discovery_sha256,
  plugin_id: compatibility.plugin_id,
  plugin_version: compatibility.plugin_version,
})) if (packageLock[key] !== expected) fail(`Claude package lock differs for ${key}`);
if (packageLock.platform !== "claude" || archiveLock.platform !== "claude") fail("Claude lock platform is invalid");
sha256(packageLock.artifact_sha256, "Claude package artifact digest");
sha256(archiveLock.archive_sha256, "Claude archive digest");
if (packageDigest(repo, expectedCommit, `${generated}/claude`) !== packageLock.artifact_sha256 ||
    createHash("sha256").update(sourceBlob(`${generated}/claude.zip`)).digest("hex") !== archiveLock.archive_sha256) {
  fail("committed package or archive bytes do not match their lock");
}
const packageEntries = archive
  ? [...archive.files.entries()].filter(([path]) => path.startsWith(`${generated}/claude/`)).map(([path, body]) => [path.slice(`${generated}/claude/`.length), body])
  : execFileSync("git", ["ls-tree", "-r", "-z", expectedCommit, "--", `${generated}/claude`], { cwd: repo }).toString("utf8").split("\0").filter(Boolean).map((entry) => {
      const [, , path] = /^(?:\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(entry) ?? [];
      if (!path) fail("invalid committed package tree entry");
      return [path.slice(`${generated}/claude/`.length), gitBlob(repo, expectedCommit, path)];
    });
const zipped = zipEntries(sourceBlob(`${generated}/claude.zip`));
if (zipped.size !== packageEntries.length || packageEntries.some(([path, body]) => !zipped.get(path)?.equals(body))) {
  fail("generated ZIP entries differ from the committed package tree");
}

const fixture = { sourceCommit: expectedCommit, compatibility, packageLock, archiveLock };
const json = `${JSON.stringify(fixture, null, 2)}\n`;
const source = `// Generated from Exomem compatibility.json at commit ${expectedCommit}. Do not edit.\nexport const exomemHostedContractFixture = ${JSON.stringify(fixture, null, 2)} as const;\n`;
writeFileSync(output, source, { encoding: "utf8", mode: 0o644 });
writeFileSync(jsonOutput, json, { encoding: "utf8", mode: 0o644 });
