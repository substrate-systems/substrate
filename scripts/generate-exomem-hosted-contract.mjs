#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
if (actualCommit !== expectedCommit) fail("Exomem checkout is not at the selected commit");
if (execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() !== "") {
  fail("Exomem checkout must be clean before generating a release fixture");
}

const venvPython = resolve(repo, ".venv/bin/python");
const python = existsSync(venvPython) ? venvPython : "python3";
const contract = JSON.parse(
  execFileSync(
    python,
    [
      "-c",
      [
        "import json",
        "from exomem.hosted_gateway import build_gateway_contract",
        "print(json.dumps(build_gateway_contract(), separators=(',', ':'))) ",
      ].join("; "),
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: resolve(repo, "src") },
      maxBuffer: 16 * 1024 * 1024,
    }
  )
);

if (
  typeof contract.exomem_release !== "string" ||
  typeof contract.protocol_version !== "string" ||
  !/^[0-9a-f]{64}$/.test(contract.digest?.value) ||
  !Array.isArray(contract.commands)
) {
  fail("Exomem emitted an invalid gateway contract");
}

const commands = contract.commands.map((command) => {
  if (
    typeof command.name !== "string" ||
    typeof command.read_only !== "boolean" ||
    !["read", "write"].includes(command.mode) ||
    !Number.isInteger(command.tier) ||
    typeof command.capability !== "string" ||
    !Array.isArray(command.params) ||
    !Array.isArray(command.guarded_fields)
  ) {
    fail("Exomem emitted an invalid command contract");
  }
  return [
    command.name,
    command.read_only,
    command.mode,
    command.tier,
    command.capability,
    command.params.map((parameter) => [parameter.name, parameter.type, parameter.required]),
    command.guarded_fields,
  ];
});

const identifier = contract.exomem_release.replaceAll(/[^0-9A-Za-z]/g, "");
const source = `// Generated from Exomem ${contract.exomem_release} commit ${actualCommit} build_gateway_contract(); semantic fields only.
export type ExomemContractCommandFixture = readonly [
  name: string,
  readOnly: boolean,
  mode: "read" | "write",
  tier: number,
  capability: string,
  params: readonly (readonly [name: string, type: string, required: boolean])[],
  guardedFields: readonly string[],
];

const commands = ${JSON.stringify(commands, null, 2)} as const satisfies readonly ExomemContractCommandFixture[];

export const exomemContractFixture${identifier} = {
  sourceCommit: "${actualCommit}",
  release: "${contract.exomem_release}",
  protocol: "${contract.protocol_version}",
  digest: "${contract.digest.value}",
  commands,
} as const;
`;

writeFileSync(output, source, { encoding: "utf8", mode: 0o644 });
writeFileSync(jsonOutput, `${JSON.stringify(contract, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
