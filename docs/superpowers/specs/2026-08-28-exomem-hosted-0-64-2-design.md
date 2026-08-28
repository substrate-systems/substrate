# Exomem Hosted stable-release rollout design

## Goal

Ship Exomem Hosted to the friends alpha on one exact stable Exomem release with
the full `hosted-alpha-agent-v4` 25-command surface working in Claude and
ChatGPT. Leave behind a repeatable, fail-closed version-bump path so later
stable releases are routine rather than bespoke production surgery.

## Release gate discovered during design

Exomem `v0.64.2` is the latest published stable release at commit
`c8ba4be7779640a374fc78e9b67274ca7943ca07`. Its release includes a signed
Hosted runtime candidate for image digest
`sha256:14207e35de218534212a5702b3313945ce0df90d74d190803ce504baf3f240c5`.
The v4 command membership remains the expected 25 commands and keeps command
fingerprint `4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968`.

The release is not yet a valid paired-client release unit. Its Claude v4 lock
uses schema digest
`55f704688e015a4497f9ca8da49169a717c282aacec838bfde52c08c12cdf95c`
and compatibility digest
`4a12a115086166c5b37cde02e6bfcc6aa2c095b6d073dc23f5634803b13c0ce9`,
while its OpenAI v4 lock still carries the prior `0.63.1` values. The existing
reviewer harness correctly rejects that cross-platform drift. Production must
not weaken that check or import a mixed release.

## Chosen approach

Use two serialized release units.

First, correct the upstream Exomem release pipeline and publish the next stable
patch release. Regenerate and check both Claude and OpenAI v4 package/archive
artifacts from the same source tree and registered-app identity, and make the
release workflow repeat that check so future source releases cannot leave v4
OpenAI stale. The new tag must publish its own signed Hosted runtime candidate.
The exact resulting tag, commit, image digest, candidate digest, and v4 contract
digests become the only admissible downstream target.

Second, import that exact release into Substrate using the existing additive
catalog, same-cell rollforward, paired-review, and one-shot promotion controls.
Do not add another profile: `hosted-alpha-agent-v4` remains the profile, while
release and contract digests distinguish the new immutable unit from `0.63.1`.

The rejected alternatives are deploying `0.64.2` with the stale OpenAI lock,
which would make the paired-client claim false, and floating the runtime at a
mutable latest tag, which would destroy reproducibility and rollback identity.

## Upstream Exomem release unit

The upstream change will:

- add a red regression test proving the release synchronization step covers
  the current v4 candidate for both platforms;
- regenerate the v4 OpenAI package and archive from the same registered-app
  identity already bound by its checked lock, without logging the raw value;
- require Claude and OpenAI v4 locks to agree on command, schema, and
  compatibility digests;
- update release synchronization to render and check v4 alongside the existing
  release-managed candidates; and
- pass the focused Hosted artifact tests, full relevant CI, clean render/check,
  and release-asset publication checks before the next patch tag is accepted.

Historical promoted artifacts remain immutable evidence. This change updates
the pending v4 release candidate; it does not rewrite prior production rows or
pretend the `0.64.2` mixed lock was promotable.

## Substrate release import

After the corrected stable tag exists, Substrate will add one trusted catalog
entry containing its exact source commit, signed runtime image, runtime
candidate SHA-256, protocol `1`, profile `hosted-alpha-agent-v4`, gateway
contract digest, command fingerprint, schema digest, and compatibility digest.
Generated agent and full-gateway fixtures must come from a clean checkout at
that tag and must describe the same ordered 25 commands for Claude and OpenAI.

The trusted runtime report, generator allowlist, cohort target, migrations,
tests, and operator runbook will advance to that exact unit. Existing `0.63.1`
and older rows remain historical and usable only through their existing
rollback/import rules. No migration rewrites a historical profile or release.

## Production sequence

Production work stays serialized and stops at the first failed invariant:

1. Verify the new release tag, source commit, runtime candidate bytes, image
   provenance, and both Sigstore bundles.
2. Keep the external reconciler scheduler suspended while inspecting the
   abandoned reviewer tenant, terminal deletion, and capacity claim. Recover it
   only through the authenticated deletion/replay controls already in the
   runbook; do not edit database state or bypass owner authority.
3. Prove a clean fleet: no inconsistent live cell, stale capacity claim,
   unfinished operation, missing runtime identity, or ghost routable row.
4. Apply the additive Substrate migration and deploy the control-plane release.
5. Install the exact signed runtime target in the deployment lock and perform
   the same-cell rollforward with export/quiesce/continuity proof and explicit
   readiness identity checks.
6. Import the pending agent/gateway candidate, attach the matching OpenAI locks,
   and stage Claude and ChatGPT against the same tenant, cell, assignment,
   generation, and evidence window.
7. Run both native clients through OAuth, exact 25-tool discovery, cited recall,
   durable capture, fresh-chat recall, and representative read/write commands.
   Sign and import both evidence records, then promote once.
8. Reconnect both clients and repeat production discovery and smoke checks.
9. Run a fresh sandbox paid journey from invite through checkout, provisioning,
   connector authorization, use, export, and authenticated two-step deletion.
   Verify completion email and capacity release.
10. Restore the scheduler only after its secret, freshness, and first live
    reconciliation are proven healthy.

No production invitation is sent to friends until steps 1-10 are green.

## Failure handling and rollback

Before promotion, failure retires the pending candidate and leaves the current
cohort untouched. After runtime rollforward but before promotion, the cell is
quiesced and recovered through the existing retained export and immutable prior
runtime target. After promotion, rollback imports the exact prior trusted unit,
collects fresh paired evidence, and promotes it through the same one-shot path;
it never relabels a new runtime as an old release.

The scheduler stays suspended during any ambiguous deletion, capacity, runtime,
or promotion state. A mixed client lock, missing signed candidate, failed
continuity proof, non-25 discovery result, ghost routable cell, or stale claim is
a hard stop rather than a warning.

## Verification and completion

Completion requires checked evidence for:

- upstream v4 Claude/OpenAI digest equality and release-workflow coverage;
- signed stable runtime provenance and immutable image identity;
- generated Substrate agent/gateway fixtures with exactly 25 ordered commands;
- additive migration and clean fleet preflight;
- live cell release/profile/digest readiness and vault continuity;
- fresh Claude and ChatGPT OAuth, discovery, behavior, and paired promotion;
- fresh paid onboarding, export, deletion confirmation, completion email, and
  released capacity; and
- a dry-run of the documented next-version import and rollback commands using
  non-production fixtures.

The release is ready for friends only when those checks pass from clean clients
and the production scheduler is healthy again.
