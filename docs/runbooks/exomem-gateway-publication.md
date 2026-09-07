# Exomem gateway image publication

This procedure publishes a reviewed gateway image. It never deploys it or
changes the public MCP edge. Helm remains a separate, digest-pinned consumer.

## Prerequisites

- The reviewed source is merged to `substrate-systems/substrate` `main`.
- The gateway Helm Deployment has no image-pull credential path. The package
  `ghcr.io/substrate-systems/substrate-gateway` must already be public before
  dispatching the publisher and remain public for rollout. A package owner makes
  that visibility decision separately in GitHub Packages; this workflow and
  runbook never change package visibility. If a private package is required,
  stop and add a reviewed Helm pull-secret path before publication or deployment;
  never add a personal registry token or a production secret.
- The operator has authenticated `gh` and Docker access to the package.

## Publish one reviewed source revision

Resolve the current canonical source SHA and prove that its primary CI push run
completed successfully before dispatching the publisher:

```bash
repo=substrate-systems/substrate
source_sha="$(gh api "repos/$repo/commits/main" --jq .sha)"
test "${#source_sha}" -eq 40
gh run list --repo "$repo" --workflow test.yml --event push --branch main \
  --commit "$source_sha" --status success --limit 1
```

If that command returns no successful run, do not dispatch. Resolve the CI
failure or wait for the push run. Dispatch only `main`:

```bash
gh workflow run publish-exomem-gateway.yml --repo "$repo" --ref main
```

Select the resulting manual run by checking every displayed field, rather than
using the newest run from another source revision:

```bash
gh run list --repo "$repo" --workflow publish-exomem-gateway.yml \
  --event workflow_dispatch --branch main --commit "$source_sha" \
  --json databaseId,headSha,headBranch,event,status,conclusion,url
gh run view <database-id> --repo "$repo" \
  --json databaseId,headSha,headBranch,event,status,conclusion,url
```

Proceed only if the selected run has `headSha` equal to `source_sha`,
`headBranch` `main`, event `workflow_dispatch`, and conclusion `success`. The
workflow itself repeats the repository, ref, event, and exact-successful-CI
checks before it logs in or pushes.

## Read back and verify before Helm

Resolve the source-SHA discovery tag to one immutable digest. Record and pass
only the `@sha256:` form to Helm; do not use a mutable tag.

```bash
image_tag="ghcr.io/substrate-systems/substrate-gateway:${source_sha}"
gh auth token | docker login ghcr.io -u "$(gh api user --jq .login)" --password-stdin
digest="$(docker buildx imagetools inspect "$image_tag" --format '{{.Manifest.Digest}}')"
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "invalid image digest" >&2
  exit 1
fi
image="ghcr.io/substrate-systems/substrate-gateway@${digest}"
docker buildx imagetools inspect "$image"
```

Perform an anonymous manifest readback before Helm. This proves the current
gateway pod can pull the exact digest without an unmodelled registry credential:

```bash
pull_token="$(
  curl --fail --silent --show-error \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:substrate-systems/substrate-gateway:pull" \
    | node --input-type=module -e '
        import { readFileSync } from "node:fs";
        const { token } = JSON.parse(readFileSync(0, "utf8"));
        if (!token) process.exit(1);
        process.stdout.write(token);
      '
)"
curl --fail --silent --show-error \
  --header "Authorization: Bearer ${pull_token}" \
  --header 'Accept: application/vnd.oci.image.index.v1+json' \
  "https://ghcr.io/v2/substrate-systems/substrate-gateway/manifests/${digest}" \
  > /dev/null
```

An authorization failure or a non-success response is a stop condition. Do not
add a cluster pull secret as a workaround outside a reviewed Helm change.

Verify provenance against the exact repository, publisher workflow, source ref,
and source SHA before selecting the image in Helm:

```bash
gh attestation verify "oci://${image}" \
  --repo substrate-systems/substrate \
  --signer-workflow substrate-systems/substrate/.github/workflows/publish-exomem-gateway.yml \
  --signer-digest "$source_sha" \
  --source-ref refs/heads/main \
  --source-digest "$source_sha" \
  --deny-self-hosted-runners
```

The result must verify the exact immutable image. A missing attestation,
different source SHA/ref, workflow, repository, or digest is a stop condition;
do not replace it with a tag or a manual trust decision. Deployment is a later
reviewed Helm change, with its own rollout and acceptance evidence.
