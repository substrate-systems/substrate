import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildHostedRuntimeTrustReport,
  canonicalHostedRuntimeTrustReport,
} from "../src/lib/exomem-hosted/runtime-trust-report";

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const targetIndex = arguments_.indexOf("--target");
  const outputIndex = arguments_.indexOf("--output");
  if (
    targetIndex < 0 ||
    outputIndex < 0 ||
    !arguments_[targetIndex + 1] ||
    !arguments_[outputIndex + 1]
  ) {
    throw new Error("usage: verify-exomem-hosted-runtime-trust --target PATH --output PATH");
  }
  const repository = process.cwd();
  execFileSync("git", ["diff", "--quiet"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: repository, stdio: "ignore" });
  const consumerCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const target = JSON.parse(await readFile(resolve(arguments_[targetIndex + 1]!), "utf8"));
  const report = await buildHostedRuntimeTrustReport({ repository, consumerCommit, target });
  await writeFile(
    resolve(arguments_[outputIndex + 1]!),
    canonicalHostedRuntimeTrustReport(report),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `hosted runtime trust: ${error instanceof Error ? error.message : "failed"}\n`
  );
  process.exitCode = 2;
});
