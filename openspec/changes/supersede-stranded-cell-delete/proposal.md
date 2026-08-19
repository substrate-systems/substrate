## Why

`correct-diverged-cell-release` shipped on the premise that moving a cell's recorded release onto the runtime it actually serves would let its stranded deletion be re-issued. Applied in production on 2026-08-19 that premise proved false, and the tenant stayed stuck.

Two facts close the path, neither of which the earlier change checked:

- `consumeDeletionConfirmationAtomic` requires `tenant.status IN ('provisioning', 'active', 'suspended')`. A tenant already at `deletion_pending` cannot mint a fresh delete, so nothing can create an operation that would derive the corrected target.
- The reconciler builds the provisioner request from the **operation**, not the cell — `runtimeTarget: this.#runtimeTarget(operation)`. The stranded operation's `target_*` columns were copied at creation and are frozen at the old release, so reopening it re-sends exactly the target admission already refused.

A cell correction therefore repairs the record and nothing about the operation. The record still needed correcting — promotion probes the routable set and a lying observation is its own problem — but it is a precondition, not the repair.

Tenant destruction already has an admissible shape. A **target-free** delete carries `cell_id` and every `target_*` column NULL, so there is no `runtimeTarget` for admission to compare and the deployment lock is irrelevant to it. `recover-expired-reviewer-cleanup` already enqueues exactly that shape for a different precondition. This change reaches it from the one we are actually in.

## What Changes

- Add one authenticated operator action, plus its read-only preflight, that supersedes a stranded cell-scoped delete with a target-free tenant delete at the next fence.
- Require the stranded operation to sit at checkpoint `local-gated` with `PROVISIONER_REJECTED`. That checkpoint is the last one before the first provider call, so the operation being superseded is provably one whose provider-side destruction never began.
- Advance the tenant fence, terminalize the stranded operation as `DELETION_SUPERSEDED`, end any live rollout assignment, and enqueue the replacement — all in one transaction under the cohort lock.
- Return only a content-free outcome and the opaque replacement operation identity, and replay to the same result.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-tenant-control-plane`: Add a narrowly scoped operator-authorized supersession that restores a permanently inadmissible cell-scoped delete to the target-free shape tenant destruction is meant to use.

## Impact

- `src/lib/exomem-hosted/operator-controls.ts` gains the eligibility, supersession and replay branches.
- `src/app/api/exomem/admin/contracts/route.ts` exposes both actions through the existing rate-limited operator boundary.
- `src/lib/exomem-hosted/__tests__/postgres.integration.test.ts` proves the replacement is target-free on every column, that the fence advances, that replay enqueues nothing further, and every refusal boundary.
- `docs/runbooks/exomem-hosted-alpha.md` gains the procedure and states plainly that the cell correction alone does not unstick a delete.
- `openspec/changes/correct-diverged-cell-release/` records the falsified premise rather than leaving it to read as complete.

## Non-goals

- Rescuing a delete that already reached the provider. Past `local-gated` the provider may hold partial destruction, and reasoning about that from the control plane alone is exactly the guess this codebase avoids.
- Changing what `consumeDeletionConfirmationAtomic` accepts. Widening it to `deletion_pending` would let an owner mint a second concurrent delete, which is a larger and more dangerous change than restoring one operation to an admissible shape.
