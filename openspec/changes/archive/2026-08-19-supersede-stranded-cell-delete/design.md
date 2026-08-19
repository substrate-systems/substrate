# Design

## Why the earlier repair was insufficient

`correct-diverged-cell-release` moved a cell's recorded release onto the runtime it serves and installed a matching active assignment, on the reasoning that a delete derives its target from `bound_assignment_target`. That reasoning is correct for an operation *not yet created*. It says nothing about one that already exists.

Lifecycle operations copy their target at creation into `target_*` columns, and `reconciler.ts` builds the provisioner request from the operation:

```ts
runtimeTarget: this.#runtimeTarget(operation)
```

So the stranded delete kept presenting the release the deployment lock had already refused, no matter what the cell underneath it said. And no *new* delete could be created either, because `consumeDeletionConfirmationAtomic` accepts only `provisioning`, `active` or `suspended` — never `deletion_pending`.

The general shape of the mistake is worth naming: a repair aimed at some state does nothing for records that copied that state at creation. Copy-at-creation is invisible until you try to fix the source.

## Why target-free is the escape

Migration 0045's `exomem_lifecycle_v2_target_check` explicitly permits one shape with no target at all:

```sql
operation_type = 'delete'
AND cell_id IS NULL AND expected_previous_cell_id IS NULL
AND target_candidate_id IS NULL AND ... -- every target column NULL
```

That is not an oversight, it is how v2 tenant destruction is meant to run, and `recover-expired-reviewer-cleanup` already enqueues it. Admission compares `runtimeTarget` only when the request carries one, so a target-free delete cannot be rejected for a runtime mismatch. The lock becomes irrelevant to it.

The reconciler already routes such an operation correctly: `#sealOrDelete` skips the per-cell quiesce and seal when `cellId` is null and goes to `#tenantDestroyTarget`, which carries no runtime identity.

## The cell still gets cleaned up

A target-free delete names no cell, which raises the obvious worry that the cell and its routable row would be orphaned. They are not. `markCellState` widens its match when deleting:

```sql
WHERE cell.tenant_id = owned.tenant_id
  AND (${deleting} OR cell.id = owned.cell_id)
```

So the destroy marks every cell of the tenant deleted, and the `routable_cleared` CTE added in #123 clears each one's routable observation in the same statement. Capacity is released by the ordinary finalizer.

This matters beyond tidiness: promotion health-probes every routable cell and requires all probes to succeed, so a routable row left behind blocks every future cohort promotion.

## Why `local-gated` is the safety boundary

`local-gated` is the last checkpoint before the first provider call — at it, the local gate has been applied and `quiesce` has not succeeded. An operation sitting there provably has no provider-side destruction in progress, so superseding it cannot orphan destructive work.

Past that checkpoint the provider may hold partial state, and the control plane cannot establish what from its own tables. The control refuses rather than guess. That is the one irreversible mistake available here, so it is the one clause the tests mutate to prove it bites.

## Open questions

- Whether `correct-diverged-cell-release` should refuse outright when the tenant is already `deletion_pending`, since in that state its stated purpose — letting a later operation derive the corrected target — cannot be achieved. It is still worth running for the routable observation, so the honest answer may be a narrower promise rather than a refusal.
