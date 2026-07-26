#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PROFILE = "hosted-alpha-agent-v1";
const RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";

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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} must be readable JSON`);
  }
}

const args = argumentsFrom(process.argv.slice(2));
const repoArg = args.get("exomem-repo");
const outputArg = args.get("output");
const jsonOutputArg = args.get("json-output");
const expectedCommit = args.get("expected-commit") ?? "";
if (!repoArg || !outputArg || !jsonOutputArg || !/^[0-9a-f]{40}$/.test(expectedCommit)) {
  fail("required: --exomem-repo PATH --output PATH --json-output PATH --expected-commit FULL_SHA");
}
const repo = resolve(repoArg);
const output = resolve(outputArg);
const jsonOutput = resolve(jsonOutputArg);
const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
if (actualCommit !== expectedCommit) fail("Exomem checkout is not at the selected commit");
if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() !== "") {
  fail("Exomem checkout must be clean before generating a release fixture");
}

const generated = resolve(repo, "plugins/hosted/generated");
const compatibility = object(readJson(resolve(generated, "compatibility.json"), "compatibility artifact"), "compatibility artifact");
const agentContract = object(compatibility.agent_contract, "agent contract");
const agentProfile = object(agentContract.agent_profile, "agent profile");
const digest = object(agentContract.digest, "agent contract digest");
const packageLock = object(readJson(resolve(generated, "claude.lock.json"), "Claude package lock"), "Claude package lock");
const archiveLock = object(readJson(resolve(generated, "claude.zip.lock.json"), "Claude archive lock"), "Claude archive lock");
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
for (const [key, expected] of Object.entries({
  endpoint: RESOURCE, profile: PROFILE,
  command_surface_sha256: compatibility.command_surface_sha256,
  schema_contract_sha256: compatibility.schema_contract_sha256,
  compatibility_sha256: compatibility.compatibility_sha256,
})) if (packageLock[key] !== expected) fail(`Claude package lock differs for ${key}`);
if (packageLock.platform !== "claude" || archiveLock.platform !== "claude") fail("Claude lock platform is invalid");
sha256(packageLock.artifact_sha256, "Claude package artifact digest");
sha256(archiveLock.archive_sha256, "Claude archive digest");

const fixture = { sourceCommit: actualCommit, compatibility, packageLock, archiveLock };
const json = `${JSON.stringify(fixture, null, 2)}\n`;
const source = `// Generated from Exomem compatibility.json at commit ${actualCommit}. Do not edit.\nexport const exomemHostedContractFixture = ${JSON.stringify(fixture, null, 2)} as const;\n`;
writeFileSync(output, source, { encoding: "utf8", mode: 0o644 });
writeFileSync(jsonOutput, json, { encoding: "utf8", mode: 0o644 });
