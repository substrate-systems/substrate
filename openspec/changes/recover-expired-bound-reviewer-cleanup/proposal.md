## Why

A reviewer bootstrap can provision and bind its dedicated cell before the human-timed evidence ceremony fails or expires. The existing expired-reviewer recovery deliberately accepts only an unbound candidate in `candidate-cleanup`, so this successful-but-expired reviewer tenant blocks every fresh bootstrap while its sealed owner session cannot reach ordinary deletion.

## What Changes

- Extend the authenticated expired-reviewer cleanup preflight and recovery to accept one caller-pinned, successfully bound reviewer `provision` operation at its exact current fence.
- Require fail-closed proof that the tenant and assignment are immutable reviewer-purpose records, the assignment is expired or exactly terminal-failed, the provision operation succeeded at `bound`, the tenant has exactly one matching active/routable/ready bound cell, and no live assignment, bootstrap, or conflicting lifecycle authority remains.
- Reuse the existing atomic authority revocation, product gate, higher-fence target-free tenant deletion, derived idempotency key, replay, and principal-bound audit boundary.
- Continue to refuse customer tenants, arbitrary tenant/cell/volume selectors, ambiguous cells, active assignments or bootstrap authority, stale fences, incomplete provisions, and any other bound lifecycle state. Residual tenant-bound credentials, sessions, and OAuth grants are accepted only because the locked recovery transaction revokes their complete lineage atomically.
- Document the exact fail-assignment, preflight, recovery, reconcile, and externally verified destruction sequence before another reviewer ceremony.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-tenant-control-plane`: Permit the existing expired-reviewer cleanup to recover one exact successful bound reviewer provision after its immutable assignment becomes unusable, without creating a general operator deletion bypass.

## Impact

- `src/lib/exomem-hosted/operator-controls.ts` extends the existing read-only eligibility and atomic recovery predicates plus exact replay. `reviewer-access-store.ts` and `db.ts` serialize reviewer credentials, sessions, magic-link redemption, and transfer grants with recovery; session and transfer consumption also fail closed after the deletion gate.
- The existing contracts-admin actions remain the only API surface; request and response shapes do not change.
- PostgreSQL, route/contract, concurrency, and refusal tests cover the bound-success case, prove racing authority is revoked or refused, and prove ordinary tenants, volumes, and other bound states remain unreachable.
- `docs/runbooks/exomem-hosted-alpha.md` gains the successful-bound reviewer recovery sequence.
