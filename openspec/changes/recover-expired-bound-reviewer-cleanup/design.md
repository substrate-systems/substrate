## Context

The reviewer bootstrap seals ordinary owner access as soon as internal canary credentials are issued. A fast provision can nevertheless reach `succeeded/bound` before either native-client evidence chain is imported. If the human-timed assignment then expires, the tenant remains a healthy, routable reviewer-purpose cell that blocks another bootstrap, but neither the sealed owner path nor the existing unbound `candidate-cleanup` recovery can delete it.

The current operator recovery already provides the correct destructive boundary: exact source-operation/fence selection, reviewer-purpose joins, exclusive cohort locking, full authority revocation, a one-step tenant fence increase, one derived-key target-free delete, provider-owned destruction proof, exact replay, and principal-bound audit. The missing state is one additional initial-eligibility branch and its replay identity.

## Goals / Non-Goals

**Goals:**

- Recover one exact successful reviewer provision after its immutable assignment expires or is terminally failed.
- Prove the source, tenant, assignment, bound cell, readiness, routing, and absence of live assignment/bootstrap authority before mutation; revoke any residual tenant-bound session, credential, transfer, or OAuth lineage inside the deletion transaction.
- Reuse the existing higher-fence target-free delete and externally verified provider finalization.
- Keep requests and responses content free and make retries exact.

**Non-Goals:**

- General operator deletion of customers, arbitrary tenants, cells, or volumes.
- Cleanup of an incomplete, restoring, suspended, diverged, multi-cell, or otherwise ambiguous bound tenant.
- Extending or replacing expired assignments, fabricating evidence, or marking provider destruction complete.
- Changing the ordinary owner deletion flow.

## Decisions

### Extend the existing expired-reviewer actions, not the public API

`preflight-recover-expired-reviewer-cleanup` and `recover-expired-reviewer-cleanup` keep their exact `{sourceOperationId, expectedFence}` request and content-free response. Internally, initial eligibility becomes the union of the existing unbound cleanup state and one successful-bound reviewer state. A new action was rejected because it would duplicate the same authority and deletion transaction while making operational selection easier to confuse.

### Admit only one exact successful-bound state

The new branch requires all common reviewer lineage predicates plus:

- the source is a completed, error-free V2 `provision`, `succeeded`, and checkpoint `bound`, at the caller-pinned tenant fence with no lease owner or expiry;
- the source cell is the tenant's sole non-deleted cell and equals `tenant.bound_cell_id`;
- the tenant is reviewer-purpose, active, desired-running, and not deleted;
- the cell is active, bound, desired-running, provider-backed, and records `CELL_READY`, its full observed runtime identity equals the source target, and the matching Hosted route observation is still routable;
- the exact joined reviewer assignment is expired at its immutable expiry or terminal `failed` with `ended_at`, with no other live assignment, bootstrap authority, or unfinished current-fence operation.

The caller never supplies tenant, cell, owner, provider, or volume identity. All are derived from and locked through the exact source operation. Allowing restore, suspended/retiring cells, absent readiness, or multiple cells was rejected because those states require a different recovery proof.

### Reuse the existing atomic deletion transaction

Recovery takes the cohort advisory lock and then the reviewer-access advisory lock before evaluating its mutation statement, matching the canonical internal-canary order. Reviewer credential and direct reviewer-session writers take the matching reviewer lock. Magic-link redemption and transfer-grant mint/consume take the shared cohort lock, so cleanup cannot miss newly committed Hosted authority after its mutation snapshot. Session lookup rejects a deletion-pending, deleted, or account-blocked tenant, and transfer consumption rechecks the active/running tenant, exact active/bound cell, ownership, and absence of an account block. After eligibility, the same transaction gates the tenant, increments its fence once, blocks and revokes Hosted/reviewer/OAuth authority, gates entitlement and exports, and inserts one normal target-free delete using the source-derived key. The successful source remains truthful as `succeeded/bound`; unlike an unfinished cleanup source, it is not rewritten as `DELETION_SUPERSEDED`.

Residual tenant-bound credentials, sessions, transfer grants, and OAuth grants are revocation inputs, not eligibility blockers. Because their writers are serialized ahead of the cleanup snapshot, recovery either sees and revokes the committed authority or gates first and makes the writer fail closed. Consumed access tokens remain consumed rather than being marked revoked, preserving the database's mutually exclusive terminal-state invariant; their resulting session is revoked and the tenant/account gate independently prevents reuse.

Exact replay therefore accepts either the existing superseded cleanup source or the unchanged successful-bound source, but only when the tenant is already deletion-pending at exactly `old fence + 1` and exactly one derived-key target-free delete exists at that fence. It cannot authorize a new transition.

### Keep destruction proof provider-owned

Recovery reports only enqueue/replay. The ordinary reconciler closes routing and runs target-free DESTROY. Compute, storage, keys, tenant resources, control-plane deletion, routable-observation removal, and capacity release must all converge through existing proofs before a fresh reviewer bootstrap.

## Risks / Trade-offs

- **[A healthy customer is deleted]** → Require immutable reviewer-purpose markers on both tenant and assignment plus exact source lineage; accept no tenant/cell/volume selector.
- **[An ambiguous bound state is deleted]** → Require one cell, exact binding equality, active/routable/running state, `CELL_READY`, succeeded `bound` provision, and no conflicting operation.
- **[Authority races recovery]** → Take cohort then reviewer locks exclusively in cleanup; make reviewer credentials/sessions, magic redemption, and transfer-grant mint/consume take their matching shared lock; recheck tenant/cell/account gates when resolving or consuming authority.
- **[Retry enqueues another delete]** → Bind replay to the source-derived key, old fence, tenant at exactly the next fence, and exactly one target-free delete.
- **[Recovery is mistaken for deletion completion]** → Return `enqueued`/`replayed` only and require provider/control/capacity verification in the runbook.

## Migration Plan

1. Land and deploy the additive predicate/test/runbook change; no schema or environment change is required.
2. Terminally fail the exact expired assignment by its ID and current version if it is still recorded active.
3. Preflight and recover using only the exact successful provision operation and current fence.
4. Reconcile until normal target-free DESTROY proves provider and control deletion plus capacity release.
5. Verify no reviewer/OAuth authority or routable cell remains, then begin a fresh reviewer ceremony.
6. Rollback removes only the broadened operator eligibility after no recovery is in flight; committed deletion state remains authoritative.

## Open Questions

None.
