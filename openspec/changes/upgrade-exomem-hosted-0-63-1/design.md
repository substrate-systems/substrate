## Context

Production Hosted currently treats `hosted-alpha-agent-v1` as a global current profile and imports the bare Exomem generated artifact directory for release `0.57.2`. Stable Exomem `0.63.1` commit `35f6d7bb` publishes the reviewed v4 candidate under `plugins/hosted/generated/candidates/hosted-alpha-agent-v4`; its Claude and OpenAI locks describe 25 registry commands and plugin version `0.4.0`. The control plane already has exact-commit contract import, per-candidate evidence, same-cell forward-only rollforward, and one-shot paired-client promotion.

The old v1 candidate rows and generated fixtures are retained operational history. They cannot be relabelled as v4 because profile identity participates in authorization, routable observations, evidence, and digests.

## Goals / Non-Goals

**Goals:**

- Import only the exact 0.63.1/v4 artifacts and derive the 25-tool surface from Exomem's committed registry output.
- Make v4 the current private-alpha profile while retaining v1 catalog data unchanged.
- Bind gateway private routes, OAuth credentials, lifecycle operations, observations, reviewer evidence, and promotion to one exact release/profile/digest tuple.
- Reuse the existing rollforward and paired Claude/ChatGPT promotion machinery.

**Non-Goals:**

- Public self-serve Exomem, new billing behavior, or changes to the hosted public resource URL.
- A general multi-profile product selector exposed to callers.
- Downgrading cells through rollforward or mutating old v1 artifacts.
- Hand-maintaining a 25-command allowlist in Substrate.

## Decisions

### Pin release and profile as one catalog unit

The trusted release catalog will add exact commit `35f6d7bb`, release `0.63.1`, and profile `hosted-alpha-agent-v4`. Generator inputs select the profile declared for that trusted release and read the corresponding committed candidate directory. They reject any other release/commit/profile combination and verify package, archive, schema, compatibility, and registry digests before writing fixtures.

This is preferred to a caller-supplied `--profile` because the trusted catalog, not an invocation, must define the admissible tuple. It is also preferred to copying the v4 files into the old bare v1 path because that would erase the publisher's profile identity.

### Advance the current profile without rewriting legacy rows

The control plane will use one central `hosted-alpha-agent-v4` current-profile constant for new imports, assignments, observations, OAuth admission, and promotion. Existing v1 fixtures and database rows remain v1 and therefore cannot accidentally satisfy v4 joins or promotion checks.

This is a cohort rotation, not an in-place rename. A fully general profile registry is unnecessary for the private alpha, while globally rewriting v1 to v4 would break the rollback and audit boundary.

### Derive gateway routing from the resolved contract profile

The public MCP resource remains `https://substratesystems.io/api/exomem/mcp/v1`. For hosted cells, private contract and command paths will interpolate the already validated `hostedProfile` from the authoritative routing snapshot. The gateway selects its local fixture by the exact release/profile pair and verifies the private cell advertises the same tuple and digests before forwarding.

This removes the v1 path literal without allowing request-controlled profile selection. Caller arguments and OAuth requests never choose the profile.

### Promote only paired v4 evidence after same-cell verification

The existing rollforward operation remains the only forward migration path. It must verify the cell's advertised 0.63.1 release and v4 contract identity before recording the v4 routable observation. A fresh Claude and ChatGPT run then imports signed evidence for the same candidate, assignment generation, tenant, and window. Promotion remains one-shot and fails closed for stale 0.57.2 evidence, mixed profiles, or a non-25-tool artifact.

## Risks / Trade-offs

- **A remaining v1 literal makes part of the flow invisible to v4** → centralize the current profile, sweep production code and SQL, and add cross-flow tests for import, bootstrap, OAuth, routing, observation, and promotion.
- **The v4 publisher layout differs from earlier releases** → make the trusted release catalog carry the committed artifact directory and verify all locks before fixture generation.
- **A registry/profile mismatch could expose an incomplete tool surface** → assert exact command ordering and count from compatibility, Claude, OpenAI, and full gateway artifacts; never supplement it locally.
- **A bad runtime rollforward could interrupt a single-cell tenant** → use the existing forward-only checkpointed operation, retain the bound volume, verify before routing, and recover through restore rather than reverse rollforward.
- **Mixed v1/v4 history complicates queries** → current operations join on v4 explicitly while legacy catalog rows remain queryable only as their original profile.

## Migration Plan

1. Generate and test the 0.63.1/v4 agent and full gateway fixtures from a clean checkout at `35f6d7bb`.
2. Deploy the control plane with v4 admission and routing support while current v1 cells remain fail-closed until assigned.
3. Import the v4 candidate, stage the paired client artifacts, and create a fresh reviewer assignment with a sufficiently long evidence window.
4. Roll the reviewer cell forward in place to 0.63.1, verify release/profile/digests and vault continuity, then run Claude and ChatGPT against the same candidate.
5. Observe, sign, and import both platform results, promote once, and verify a paid-alpha tenant discovers all 25 tools.

Rollback before promotion retires the pending v4 candidate and leaves v1 live. After a cell rollforward, recovery uses the existing verified restore path; the system does not perform a reverse rollforward.

## Open Questions

None.
