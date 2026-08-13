## Why

An expired marketplace-reviewer assignment can leave its unbound candidate in mandatory cleanup after the owner session and reviewer authority have been revoked. If the provider has already removed the candidate but its same-fence DISCARD could not release the original capacity reservation, ordinary retry is permanently poisoned and the existing owner-confirmation path is unreachable.

## What Changes

- Add one authenticated operator action that recovers exactly this expired reviewer state by applying the existing deletion boundary at a new tenant fence.
- Require a caller-pinned lifecycle operation and expected current fence plus fail-closed database predicates: reviewer-purpose tenant, unbound candidate, mandatory cleanup, expired target assignment, no live reviewer authority/session, and no conflicting current-fence operation.
- In one transaction, revoke every Hosted and OAuth authority, supersede older lifecycle work, increment the tenant fence, enqueue the normal target-free tenant deletion operation, and persist a principal-bound audit receipt.
- Let the existing provisioner DESTROY workflow supply every external absence, key, and capacity-release proof; the operator action cannot finalize or rewrite provider state.
- Return only content-free outcome and request metadata, and document the exact incident recovery/verification sequence.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-tenant-control-plane`: Add a narrowly scoped operator-authorized deletion recovery when fresh owner confirmation is impossible only because an expired marketplace-reviewer bootstrap left an unbound candidate in mandatory cleanup.

## Impact

- `src/lib/exomem-hosted/operator-controls.ts` gains the atomic eligibility and deletion transition.
- `src/app/api/exomem/admin/contracts/route.ts` exposes the authenticated operator action through the existing rate-limited admin boundary.
- Focused PostgreSQL, route, lifecycle, and operations-contract tests prove the positive transition and every refusal boundary.
- `docs/runbooks/exomem-hosted-alpha.md` gains the content-free recovery and post-destruction verification procedure.
