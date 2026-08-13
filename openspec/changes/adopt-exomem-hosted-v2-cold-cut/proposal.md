## Why

The previous plan tried to keep the old Hosted v1 cohort and a new v2 cohort
live together. That makes a friends-only alpha needlessly risky: it requires
two routable identities, cross-profile lineage rules, rolling-writer defaults,
and a global promotion CAS while customer state still exists. It is also the
wrong plan for a cut which must be reversible and auditable in one maintenance
window.

This change replaces that rolling design with a fenced cold cut. It admits no
public writes while every old process is drained, proves no old operational or
authority state remains, replaces the legacy hard-coded cohort view, starts
only v2-aware processes, and creates a fresh reviewer/client lineage before
reopening the alpha.

## What Changes

- Establish a maintenance-window admission and public-write fence; stop and
  drain every old replica before changing the cohort.
- Assert, in the same closed window, that old lifecycle work, cells,
  assignments, exports, transfers, reviewer authority, and reachable v1 OAuth
  or client lineage are absent.
- Add only the small migration needed to replace the hard-coded v1 cohort view;
  do not add lifecycle-profile/backfill state or dual-live machinery.
- Install one v2-only process-global catalog, private routes, fixtures, and
  client catalog. Every new process enables the existing outer v2 issuance
  path.
- Verify a signed upstream release's self-describing contract before deriving
  Substrate's release-independent schema projection, then pin the resulting
  cut tuple in reviewed artifacts.
- Bootstrap a fresh reviewer and fresh staged client lineage, stage/promote it,
  perform an authenticated smoke, and reopen public writes only on proof.

## Capabilities

### New Capabilities

- `exomem-hosted-v2-cohort-adoption`: A fenced, single-cohort friends-alpha
  adoption procedure for the latest signed post-fix Exomem release selected in
  Phase B. Phase B currently expects `0.49.0`, but derives and pins no identity
  until its signed assets exist.

### Modified Capabilities

- `exomem-hosted-gateway`: Serve only the single active v2 private route after
  a successful cold cut.
- `exomem-tenant-control-plane`: Gate the cut, prove the empty old cohort, and
  issue all new lifecycle work over the outer v2 provisioner protocol.

## Impact

The implementation is intentionally smaller than the rejected rolling design:
one narrow migration, catalog/gateway/fixture replacement, operational fencing,
fresh reviewer and client setup, and a focused verification corpus. It depends
on PR #89's dual-wire support. It does not recover the expired-reviewer
incident, preserve simultaneous v1/v2 customer work, or enable public rollout.
