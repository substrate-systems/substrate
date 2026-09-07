import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const CANONICAL_REPOSITORY = "substrate-systems/substrate";
const CANONICAL_IMAGE = "ghcr.io/substrate-systems/substrate-gateway";
const WORKFLOW = ".github/workflows/publish-exomem-gateway.yml";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEqual(actual, expected, description, errors) {
  if (actual !== expected) errors.push(`missing ${description}`);
}

function requireRunLine(run, line, description, errors) {
  if (!run.split("\n").some((candidate) => candidate.trim() === line)) {
    errors.push(`missing ${description}`);
  }
}

/**
 * Keeps the deliberate, narrow registry boundary from quietly becoming a
 * per-push deploy mechanism. YAML 1.2 parsing validates the actual workflow
 * structure; the shell checks inspect executable lines rather than comments.
 */
export function verifyGatewayPublication(source) {
  let workflow;
  try {
    workflow = YAML.parse(source, { version: "1.2" });
  } catch (error) {
    throw new Error(`Gateway publication workflow is not valid YAML: ${error.message}`);
  }
  if (!isRecord(workflow)) {
    throw new Error("Gateway publication workflow must be a YAML mapping");
  }

  const errors = [];
  const triggers = workflow.on;
  if (
    !isRecord(triggers) ||
    Object.keys(triggers).length !== 1 ||
    !Object.hasOwn(triggers, "workflow_dispatch")
  ) {
    errors.push("workflow_dispatch must be the only trigger");
  }
  if (Object.hasOwn(workflow, "permissions")) errors.push("permissions must be job-scoped");

  const publish =
    isRecord(workflow.jobs) && isRecord(workflow.jobs.publish) ? workflow.jobs.publish : null;
  if (!publish) {
    errors.push("missing publish job");
  } else {
    const requiredPermissions = {
      actions: "read",
      contents: "read",
      packages: "write",
      attestations: "write",
      "id-token": "write",
    };
    if (
      !isRecord(publish.permissions) ||
      JSON.stringify(publish.permissions) !== JSON.stringify(requiredPermissions)
    ) {
      errors.push("workflow permissions must be limited to the publisher permissions");
    }

    const steps = Array.isArray(publish.steps) ? publish.steps : [];
    const admission = isRecord(steps[0]) ? steps[0] : null;
    const admissionRun = typeof admission?.run === "string" ? admission.run : "";
    requireEqual(
      admission?.name,
      "Admit only canonical main source after primary CI",
      "source admission step before publishing",
      errors
    );
    for (const [line, description] of [
      ['test "$GITHUB_EVENT_NAME" = "workflow_dispatch"', "manual dispatch gate"],
      [`test "$GITHUB_REPOSITORY" = "${CANONICAL_REPOSITORY}"`, "canonical repository gate"],
      ['test "$GITHUB_REF" = "refs/heads/main"', "main source-ref gate"],
      [
        `"/repos/${CANONICAL_REPOSITORY}/actions/workflows/test.yml/runs?event=push&head_sha=\${GITHUB_SHA}&per_page=100" \\`,
        "exact-SHA primary CI lookup",
      ],
      ["head_sha === process.env.GITHUB_SHA &&", "exact-SHA primary CI comparison"],
      ['head_branch === "main" &&', "primary CI main-branch comparison"],
      ['conclusion === "success"', "successful primary CI comparison"],
    ]) {
      requireRunLine(admissionRun, line, description, errors);
    }

    const orderedGates = [
      'test "$GITHUB_EVENT_NAME" = "workflow_dispatch"',
      `test "$GITHUB_REPOSITORY" = "${CANONICAL_REPOSITORY}"`,
      'test "$GITHUB_REF" = "refs/heads/main"',
      "gh api --paginate --slurp",
    ].map((line) => admissionRun.indexOf(line));
    if (orderedGates.some((index) => index === -1)) {
      errors.push("source admission gates must be executable");
    } else if (
      orderedGates.some((index, position) => position > 0 && index <= orderedGates[position - 1])
    ) {
      errors.push("source admission gates must precede the CI lookup in order");
    }

    const checkout = isRecord(steps[1]) ? steps[1] : {};
    const buildx = isRecord(steps[2]) ? steps[2] : {};
    const login = isRecord(steps[3]) ? steps[3] : {};
    const build = isRecord(steps[4]) ? steps[4] : {};
    const attest = isRecord(steps[5]) ? steps[5] : {};
    const anonymousPull = isRecord(steps[6]) ? steps[6] : {};
    requireEqual(
      checkout.uses,
      "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
      "pinned checkout action",
      errors
    );
    requireEqual(
      buildx.uses,
      "docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f",
      "pinned buildx action",
      errors
    );
    requireEqual(
      login.uses,
      "docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9",
      "pinned registry login action",
      errors
    );
    requireEqual(login.with?.registry, "ghcr.io", "GHCR login", errors);
    requireEqual(login.with?.password, "${{ github.token }}", "ephemeral registry token", errors);
    requireEqual(
      build.uses,
      "docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8",
      "pinned build action",
      errors
    );
    requireEqual(build.with?.file, "Dockerfile.exomem-gateway", "gateway Dockerfile build", errors);
    requireEqual(build.with?.platforms, "linux/amd64", "linux/amd64 build", errors);
    requireEqual(build.with?.push, true, "registry push", errors);
    requireEqual(
      build.with?.tags,
      `${CANONICAL_IMAGE}:${"${{ github.sha }}"}`,
      "source-SHA discovery tag",
      errors
    );
    requireEqual(build.with?.provenance, "mode=max", "build provenance", errors);
    requireEqual(build.with?.sbom, true, "SBOM generation", errors);
    requireEqual(
      build.with?.labels?.trimEnd(),
      [
        "org.opencontainers.image.revision=${{ github.sha }}",
        "org.opencontainers.image.source=https://github.com/substrate-systems/substrate",
      ].join("\n"),
      "revision and source labels",
      errors
    );
    requireEqual(
      attest.uses,
      "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
      "pinned attestation action",
      errors
    );
    requireEqual(attest.with?.["subject-name"], CANONICAL_IMAGE, "attestation subject", errors);
    requireEqual(
      attest.with?.["subject-digest"],
      "${{ steps.build.outputs.digest }}",
      "exact image digest attestation",
      errors
    );
    requireEqual(
      attest.with?.["push-to-registry"],
      true,
      "registry attestation publication",
      errors
    );
    requireEqual(
      anonymousPull.name,
      "Verify anonymous gateway manifest pull",
      "anonymous exact-digest manifest pull proof",
      errors
    );
    requireEqual(
      anonymousPull.env?.IMAGE_DIGEST,
      "${{ steps.build.outputs.digest }}",
      "anonymous pull digest binding",
      errors
    );
    const anonymousPullRun = typeof anonymousPull.run === "string" ? anonymousPull.run : "";
    for (const [line, description] of [
      [
        "https://ghcr.io/token?service=ghcr.io&scope=repository:substrate-systems/substrate-gateway:pull",
        "anonymous GHCR pull token request",
      ],
      ['--header "Authorization: Bearer ${pull_token}"', "anonymous pull authorization"],
      [
        "https://ghcr.io/v2/substrate-systems/substrate-gateway/manifests/${IMAGE_DIGEST}",
        "exact-digest manifest readback",
      ],
    ]) {
      if (!anonymousPullRun.includes(line)) errors.push(`missing ${description}`);
    }
    const normalizedAnonymousPull = anonymousPullRun
      .split("\n")
      .map((line) => line.trim())
      .join("\n");
    const manifestReadback = [
      "curl --fail --silent --show-error \\",
      '--header "Authorization: Bearer ${pull_token}" \\',
      "--header 'Accept: application/vnd.oci.image.index.v1+json' \\",
      '"https://ghcr.io/v2/substrate-systems/substrate-gateway/manifests/${IMAGE_DIGEST}" \\',
      "> /dev/null",
    ].join("\n");
    if (
      !normalizedAnonymousPull.includes(manifestReadback) ||
      /\|\|\s*(?:true|:|exit\s+0)\b/.test(anonymousPullRun)
    ) {
      errors.push("missing manifest curl failure semantics");
    }
  }

  const executableWorkflow = JSON.stringify(workflow);
  const ghcrReferences = executableWorkflow.match(/ghcr\.io\/[^"\\s]+/g) ?? [];
  if (
    ghcrReferences.some(
      (reference) =>
        !reference.startsWith(CANONICAL_IMAGE) &&
        !reference.startsWith("ghcr.io/token") &&
        !reference.startsWith("ghcr.io/v2/")
    )
  ) {
    errors.push("workflow must use only the canonical GHCR image");
  }
  if (/:latest\b/.test(executableWorkflow)) errors.push("workflow must not publish a latest tag");
  if (/\b(?:helm|kubectl|argocd)\b/.test(executableWorkflow)) {
    errors.push("workflow must not deploy the published image");
  }
  if (/\bsecrets\./.test(executableWorkflow)) {
    errors.push("workflow must not use personal or production secrets");
  }

  if (errors.length > 0) {
    throw new Error(`Gateway publication policy failed:\n- ${errors.join("\n- ")}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  verifyGatewayPublication(readFileSync(join(repositoryRoot, WORKFLOW), "utf8"));
}
