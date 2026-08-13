## Context

The marketplace-reviewer bootstrap uses short-lived assignment and session authority. A recovered provision operation reached a ready unbound candidate after that assignment expired, so binding entered mandatory `candidate-cleanup`. Substrate issued DISCARD with the provision operation's fence; the provider removed the resources but correctly refused to release a reservation created at the same fence. The provider DISCARD retry found no live target and became terminal, while the control operation remained waiting in mandatory cleanup and continued retrying against the immutable provider rejection.

The ordinary owner deletion transaction already has the correct recovery semantics: it increments the tenant fence, gates all Exomem authority, supersedes older operations, and enqueues normal tenant DESTROY. The expired reviewer session cannot reach the owner-confirmation flow, so the missing piece is a tightly bounded operator authorization for that exact transition.

## Goals / Non-Goals

**Goals:**

- Recover only an expired marketplace-reviewer bootstrap, or its exact terminal failed-assignment equivalent, whose provision/restore operation is stuck in unbound candidate cleanup.
- Reuse the normal higher-fence tenant DESTROY and its provider absence/capacity proofs.
- Make the authorization atomic, idempotent, authenticated, rate limited, and content free.
- Refuse stale, active, bound, customer, ambiguous, leased, or otherwise healthy tenants.

**Non-Goals:**

- A general operator force-delete or owner-confirmation bypass.
- Reopening or editing provider operations, fabricating DISCARD success, changing stored wire protocols, or writing SQL during incident response.
- Bulk recovery of historical cleanup rows.
- Changing provider fence semantics in this Substrate change.

## Decisions

### Add one action to the existing contracts admin boundary

`POST /api/exomem/admin/contracts` gains `preflight-recover-expired-reviewer-cleanup` and `recover-expired-reviewer-cleanup`. Both use the existing operator bearer, mutation rate limits, bounded JSON parser, and safe error mapping. Each request carries only the exact stuck operation UUID and its expected tenant fence; it never selects a tenant by email or mutable display data. The preflight executes the same read-only eligibility predicate and returns only `eligible` or a stable refusal plus request metadata. The mutation derives its lifecycle idempotency key from the immutable source operation rather than caller-chosen text.

A separate unauthenticated route was rejected because it would duplicate operator security. Reusing the owner deletion endpoint was rejected because the owner confirmation token and session are intentionally unavailable after reviewer expiry.

### Authorize and enqueue in one database statement under the cohort lock

`operator-controls.ts` performs the transition in one transaction while holding the exclusive `exomem-hosted-alpha-cohort` advisory lock before row locks. Reviewer and OAuth authority issuers already acquire the shared or exclusive form of this lock before admitting authority; tests lock that coverage and a PostgreSQL race proves that recovery cannot commit while a concurrent issuer can create usable authority. The selected row must be the unique exact operation and satisfy all of these predicates:

- operation type is provision or restore, state is `waiting` or `failed_retryable`, checkpoint is `candidate-cleanup`, lease is absent or expired, and its fence equals the caller-pinned current tenant fence;
- tenant is marketplace-reviewer-purpose, provisioning, desired running, not deleted, and has no bound cell;
- the operation's cell belongs to the tenant, is unbound, is not deleted, and is the sole non-deleted cell for that tenant;
- its immutable target assignment/candidate snapshot still matches the joined rows; the assignment is reviewer-purpose and either expired at its immutable expiry or terminal `failed` with `ended_at` set by the existing exact fail-assignment transition, without extending that immutable expiry;
- no active reviewer assignment, bootstrap authority, reviewer credential, session, OAuth transaction/code/grant/token family/access token, or other current-fence lifecycle operation except the selected source can authorize or conflict with the recovery.

On initial success the statement increments the tenant fence exactly once, sets deletion pending/desired deleted, blocks the tenant OAuth account, revokes Hosted sessions/access tokens/transfers and reviewer credentials/bootstrap authority, consumes or revokes OAuth transactions/codes/grants/families/access tokens, revokes outstanding reviewer invites, gates entitlements and exports, terminalizes all lower-fence unfinished operations as `DELETION_SUPERSEDED`, and inserts one target-free delete operation at the new fence. Refresh-token rows may remain immutable only when their revoked family makes every refresh unusable. The delete idempotency key is derived only from the immutable source operation.

Idempotent replay is a separate exact branch, evaluated before initial eligibility. It requires that same source operation at the caller's old expected fence to be `failed_terminal/DELETION_SUPERSEDED`, the same tenant to be `deletion_pending` with desired state `deleted` at exactly `old fence + 1`, and exactly one target-free delete with the derived idempotency key at that new fence. It returns that delete without another mutation. It does not generally admit terminal cleanup operations.

The initial transaction also writes two content-free rows to the existing `exomem_audit_events` table under one route request UUID and operator principal digest: one binds the source operation and selected cell to the authorized recovery, and one binds the resulting delete operation to the enqueue outcome. This is the durable recovery receipt; replay writes a separate replay audit event but does not duplicate the transition. The existing schema is sufficient, so no migration is required.

Copying only part of owner deletion was rejected: recovery must preserve the same access-revocation and product-scoping boundary. Calling several existing helpers sequentially was rejected because a crash could gate access without enqueueing destruction, or enqueue destruction without completing revocation.

### External proof remains exclusively provider-owned

The operator action reports only whether a deletion operation was enqueued or replayed plus its opaque operation/request identity. Preflight reports only eligibility or stable refusal. Neither action returns tenant, cell, assignment, provider, credential, or resource details. The mutation does not mark the cell or tenant deleted and cannot release capacity. The normal reconciler calls provider DESTROY at the higher fence; provider completion must prove compute, storage, keys, and tenant resources destroyed and then release every lower-fence reservation atomically. Only the existing final lifecycle step marks all tenant cells and the tenant deleted.

Requeueing the failed DISCARD was rejected because its immutable replay is already terminal and its original fence cannot authorize capacity release. Treating an empty provider scan as DISCARD proof was rejected because absence without durable identity is not sufficient authority.

## Risks / Trade-offs

- [The action becomes a general deletion bypass] → Require every reviewer, expired-assignment, unbound-cell, cleanup, no-live-authority, and caller-pinned fence predicate in the same statement; test each refusal independently.
- [A concurrent reviewer action races recovery] → Hold the cohort lock exclusively, retain shared/exclusive lock acquisition in every reviewer/OAuth issuer, recheck row authority under lock, and prove the race on PostgreSQL.
- [A request is retried after success] → Use a separate replay branch bound to the superseded source, old fence, tenant at exactly old-fence-plus-one, and one derived-key target-free delete.
- [The action leaves an alternate access path alive] → Revoke the union of owner-deletion and lifecycle-local-gate authority, including account block, invites, reviewer/bootstrap authority, OAuth transaction/code/grant/family/access-token authority, Hosted sessions/tokens/transfers, entitlement, and exports in the same statement.
- [The destructive authorization is not attributable] → Persist principal-bound source and result audit rows atomically with the transition using the existing audit schema.
- [DESTROY is still pending] → Report recovery as enqueued, not complete; keep the scheduler controlled and require provider/control/capacity proof before a fresh bootstrap.
- [The incident recurs for future candidates] → Land a separate provider/control regression for same-operation candidate cleanup; this operator surface remains incident recovery, not the normal path.

## Migration Plan

1. Deploy the merged dual-protocol Substrate consumer with v2 issuance off.
2. Deploy this additive operator action; no schema migration or environment change is required.
3. With scheduled reconciliation still suspended, run exact-operation preflight, then invoke the action once for that same operation and expected fence.
4. Run a bounded reconcile until the higher-fence delete reaches provider final proof and control state is deleted; verify no active reservation remains.
5. Import/stage the reviewed Exomem 0.48 contract, enable v2 only for new work, and create a fresh reviewer bootstrap within its TTL.
6. Rollback removes the operator action only after no recovery request is in flight; additive lifecycle rows and destructive proof remain authoritative.

## Open Questions

None. The action is intentionally limited to the one reviewer recovery class and cannot widen itself at runtime.
