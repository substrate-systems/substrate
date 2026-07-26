#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

function packageDigest(repo, commit, packagePath) {
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
const expectedCommit = args.get("expected-commit") ?? "";
if (!repoArg || !outputArg || !jsonOutputArg || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
  fail("required: --exomem-repo PATH --output PATH --json-output PATH --expected-commit FULL_SHA");
}
if (expectedCommit !== RELEASE_COMMIT) fail("generator only accepts the pinned Exomem release commit");
const repo = resolve(repoArg);
const output = resolve(outputArg);
const jsonOutput = resolve(jsonOutputArg);
const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
if (actualCommit !== expectedCommit) fail("Exomem checkout is not at the selected commit");
if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() !== "") {
  fail("Exomem checkout must be clean before generating a release fixture");
}

const generated = "plugins/hosted/generated";
const compatibility = object(readJson(gitBlob(repo, expectedCommit, `${generated}/compatibility.json`), "compatibility artifact"), "compatibility artifact");
const agentContract = object(compatibility.agent_contract, "agent contract");
const agentProfile = object(agentContract.agent_profile, "agent profile");
const digest = object(agentContract.digest, "agent contract digest");
const packageLock = object(readJson(gitBlob(repo, expectedCommit, `${generated}/claude.lock.json`), "Claude package lock"), "Claude package lock");
const archiveLock = object(readJson(gitBlob(repo, expectedCommit, `${generated}/claude.zip.lock.json`), "Claude archive lock"), "Claude archive lock");
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
})) if (packageLock[key] !== expected) fail(`Claude package lock differs for ${key}`);
if (packageLock.platform !== "claude" || archiveLock.platform !== "claude") fail("Claude lock platform is invalid");
sha256(packageLock.artifact_sha256, "Claude package artifact digest");
sha256(archiveLock.archive_sha256, "Claude archive digest");
if (packageDigest(repo, expectedCommit, `${generated}/claude`) !== packageLock.artifact_sha256 ||
    createHash("sha256").update(gitBlob(repo, expectedCommit, `${generated}/claude.zip`)).digest("hex") !== archiveLock.archive_sha256) {
  fail("committed package or archive bytes do not match their lock");
}

const fixture = { sourceCommit: actualCommit, compatibility, packageLock, archiveLock };
const json = `${JSON.stringify(fixture, null, 2)}\n`;
const source = `// Generated from Exomem compatibility.json at commit ${actualCommit}. Do not edit.\nexport const exomemHostedContractFixture = ${JSON.stringify(fixture, null, 2)} as const;\n`;
writeFileSync(output, source, { encoding: "utf8", mode: 0o644 });
writeFileSync(jsonOutput, json, { encoding: "utf8", mode: 0o644 });
