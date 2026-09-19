import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  buildHostedRuntimeConsumerPinReport,
  canonicalHostedRuntimeTrustReport,
} from "../src/lib/exomem-hosted/runtime-trust-report";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
}

async function main() {
  const allowed = new Set([
    "exomem-repo",
    "verifier-commit",
    "consumer-commit",
    "candidate",
    "candidate-bundle",
    "image-bundle",
    "output",
  ]);
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.slice(2);
    const value = argv[index + 1];
    if (!argv[index]?.startsWith("--") || !key || !allowed.has(key) || args.has(key) || !value) {
      throw new Error(
        "expected unique named input paths, verifier/consumer commits and output; no verification bypass is supported"
      );
    }
    args.set(key, value);
  }
  if (args.size !== allowed.size)
    throw new Error(`required: ${[...allowed].map((key) => `--${key} VALUE`).join(" ")}`);
  const producer = resolve(args.get("exomem-repo")!);
  const verifierCommit = args.get("verifier-commit")!;
  const consumerCommit = args.get("consumer-commit")!;
  if (![verifierCommit, consumerCommit].every((value) => /^[a-f0-9]{40}$/.test(value)))
    throw new Error("exact verifier and consumer commits are required");
  const candidatePath = resolve(args.get("candidate")!);
  const candidateBundle = resolve(args.get("candidate-bundle")!);
  const imageBundle = resolve(args.get("image-bundle")!);
  const candidateBytes = readFileSync(candidatePath);
  const candidateBundleBytes = readFileSync(candidateBundle);
  const imageBundleBytes = readFileSync(imageBundle);
  const candidate = JSON.parse(candidateBytes.toString("utf8"));
  const sourceCommit = candidate.source?.commit;
  const release = candidate.release?.version;
  if (
    typeof sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) ||
    typeof release !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(release)
  )
    throw new Error("invalid candidate source identity");
  const scratch = mkdtempSync(join(tmpdir(), "exomem-target-manifest-"));
  try {
    // Verify the same snapshot whose hashes enter the manifest, including the
    // candidate's original filename (it is part of the attested subject).
    const frozenCandidate = join(scratch, basename(candidatePath));
    const frozenCandidateBundle = join(scratch, "candidate.bundle.json");
    const frozenImageBundle = join(scratch, "image.bundle.json");
    writeFileSync(frozenCandidate, candidateBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(frozenCandidateBundle, candidateBundleBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(frozenImageBundle, imageBundleBytes, { flag: "wx", mode: 0o600 });
    const verifier = join(scratch, "hosted_image_candidate.py");
    const verifierBytes = execFileSync("git", [
      "-C",
      producer,
      "show",
      `${verifierCommit}:infra/scripts/hosted_image_candidate.py`,
    ]);
    writeFileSync(verifier, verifierBytes, { mode: 0o600 });
    const source = join(scratch, "release-source");
    execFileSync("git", ["clone", "--shared", "--no-checkout", producer, source], {
      stdio: "pipe",
    });
    execFileSync("git", ["-C", source, "checkout", "--detach", sourceCommit], { stdio: "pipe" });
    const agentJson = join(scratch, "agent.json");
    const gatewayJson = join(scratch, "gateway.json");
    execFileSync(
      process.execPath,
      [
        "scripts/generate-exomem-hosted-contract.mjs",
        "--exomem-repo",
        source,
        "--expected-commit",
        sourceCommit,
        "--source-release",
        release,
        "--output",
        join(scratch, "agent.ts"),
        "--json-output",
        agentJson,
        "--gateway-output",
        join(scratch, "gateway.ts"),
        "--gateway-json-output",
        gatewayJson,
      ],
      { stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }
    );
    const targetPath = join(scratch, "target.json");
    execFileSync(
      "python3",
      [
        verifier,
        "verify",
        "--candidate",
        frozenCandidate,
        "--candidate-bundle",
        frozenCandidateBundle,
        "--bundle",
        frozenImageBundle,
        "--agent-contract-fixture",
        agentJson,
        "--gateway-contract-fixture",
        gatewayJson,
        "--runtime-target-output",
        targetPath,
      ],
      { stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }
    );
    const target = JSON.parse(readFileSync(targetPath, "utf8"));
    const report = await buildHostedRuntimeConsumerPinReport({
      repository: process.cwd(),
      consumerCommit,
      target,
    });
    const fixtures = {
      agent: sha256(readFileSync(agentJson)),
      gateway: sha256(readFileSync(gatewayJson)),
    };
    if (
      fixtures.agent !== report.fixtureSha256s.agent ||
      fixtures.gateway !== report.fixtureSha256s.gateway
    )
      throw new Error("source-derived fixtures differ from the checked consumer commit");
    const manifest = {
      artifact: "exomem-hosted-runtime-target-verification",
      schemaVersion: 2,
      target,
      fixtureSha256s: fixtures,
      provenance: {
        repository: candidate.source.repository,
        ...candidate.workflow,
        predicateType: candidate.attestation.predicateType,
      },
      verification: {
        verifierCommit,
        verifierSha256: sha256(verifierBytes),
        consumerCommit,
        consumerPinReportSha256: sha256(canonicalHostedRuntimeTrustReport(report)),
        imageBundleSha256: sha256(imageBundleBytes),
        candidateBundleSha256: sha256(candidateBundleBytes),
      },
    };
    // This artifact is reviewed with the server release. It is never an API proof upload.
    writeFileSync(
      resolve(args.get("output")!),
      `${JSON.stringify(canonical(manifest), null, 2)}\n`,
      { flag: "wx" }
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `runtime target manifest: ${error instanceof Error ? error.message : "generation failed"}\n`
  );
  process.exitCode = 1;
});
