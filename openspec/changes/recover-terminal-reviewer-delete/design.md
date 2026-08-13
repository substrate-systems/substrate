## Context

One owner-confirmed reviewer deletion already received the exact four-field provider DESTROY proof and advanced to checkpoint `destroyed`. Its old local finalizer then attempted to purge a consumed bootstrap invite and revoked outcome session held by migration 0044 `ON DELETE RESTRICT` references. The transaction rolled back until the delete exhausted retries and became `failed_terminal/LIFECYCLE_MAX_ATTEMPTS`. Production now contains the fixed finalizer, but terminal work is intentionally unclaimable.

## Goals / Non-Goals

**Goals:**

- Finish only this already provider-proven reviewer delete through the normal current local finalizer.
- Bind authorization to the exact operation UUID and current fence, under the cohort lock.
- Preserve provider proof, checkpoint, fence, operation identity, and bootstrap audit lineage.
- Return and persist only content-free recovery evidence.

**Non-Goals:**

- A generic terminal-operation retry, force-delete, or capacity repair control.
- A second provider DESTROY request, a new delete operation, or reuse of expired-reviewer cleanup.
- Bulk deletion of quarantined legacy accounts or owner-confirmation bypass for those accounts.

## Decisions

### Reopen only the local finalizer

The contracts admin route gains `preflight-recover-terminal-reviewer-delete` and `recover-terminal-reviewer-delete`. Each accepts only the exact delete operation UUID and expected fence. The mutation retains `operation_type=delete`, the target-free identity, fence, idempotency key, checkpoint `destroyed`, and stored provider result. It clears terminal/error/lease metadata, resets attempts, and schedules the same row as `waiting` once. Because the reconciler's `destroyed` branch calls only `markCellState`, no provider request occurs.

Creating a new delete was rejected because it would create a second provider idempotency identity. Reopening at an earlier checkpoint was rejected because it would replay already completed destructive work. Raw SQL was rejected because it would bypass authentication, audit, and tested guards.

### Require the complete one-row incident shape

Preflight and mutation use the same eligibility predicate under the exclusive `exomem-hosted-alpha-cohort` advisory lock. The selected delete MUST be `failed_terminal/LIFECYCLE_MAX_ATTEMPTS/destroyed`, target-free, completed, lease-free, and at the caller-pinned tenant fence. The tenant MUST be reviewer-purpose, deletion-pending with desired deleted, unbound, and have exactly one nondeleted unbound cell with no provider reference. The lower-fence source MUST already be `failed_terminal/DELETION_SUPERSEDED` with its exact expired reviewer assignment. The allocation MUST be `uncertain` and pass counter-release arithmetic. The consumed bootstrap invite/session graph MUST satisfy the current retention predicates. There MUST be no other unfinished operation or live reviewer/OAuth authority.

The action writes a principal-bound audit event in the same transaction. Exact replay after reopening or success returns a bounded outcome without mutating the row again.

### Let the normal finalizer own postconditions

After recovery, one bounded reconcile claims the same delete and executes current `markCellState`. That transaction scrubs local authority and resource references, retains only the immutable consumed bootstrap invite and revoked outcome session, marks all tenant cells and the tenant deleted, and releases uncertain capacity through the existing counter-checked transition. Success is proven by the original delete becoming `succeeded/destroyed`; the operator action itself never reports deletion complete.

## Risks / Trade-offs

- [A generic retry surface emerges] → Encode every exact terminal, reviewer, bootstrap, cell, allocation, source, fence, and authority predicate; expose no caller-controlled checkpoint or state.
- [Provider work is repeated] → Preserve checkpoint `destroyed` and assert with tests that recovery reaches only the local-finalizer branch.
- [Two recoveries race] → Acquire the cohort lock, row-lock the exact delete/tenant graph, and make replay a no-op.
- [Capacity is released without proof] → Require stored `destroyed` checkpoint, preserve the delete row, and let only current `markCellState` perform the ledger transition.
- [Historical bootstrap evidence is lost] → Require and retain the exact consumed invite/revoked session linkage already protected by migration 0044.

## Migration Plan

1. Deploy the additive operator control with no schema change and keep schedulers suspended.
2. Run content-free preflight for the exact operation and fence, then invoke recovery once.
3. Run one bounded reconcile and verify delete succeeded, tenant/cells deleted, allocation released, no live authority, and bootstrap lineage retained.
4. Remove or retain the narrow control according to the normal release process; it cannot match healthy or unrelated rows.

Rollback before invocation is an ordinary application rollback. After invocation, the existing delete row and finalizer result remain authoritative; never revert database state.

## Open Questions

None.
