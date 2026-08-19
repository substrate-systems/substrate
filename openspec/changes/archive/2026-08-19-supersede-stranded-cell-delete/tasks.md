## 1. Control-plane supersession

- [x] 1.1 Add `preflightSupersedeStrandedCellDelete` and `supersedeStrandedCellDelete` to `operator-controls.ts`
- [x] 1.2 Gate on checkpoint `local-gated` with `PROVISIONER_REJECTED`, so no operation past the first provider call can be superseded
- [x] 1.3 Advance the tenant fence once, terminalize the pinned operation as `DELETION_SUPERSEDED`, and end any preparing or active assignment
- [x] 1.4 Enqueue the replacement with cell and every target column NULL, keyed on a digest derived from the superseded operation
- [x] 1.5 Write principal-bound receipts for the supersession and the replacement, and replay to the same operation

## 2. Operator boundary

- [x] 2.1 Expose both actions through the rate-limited operator admin route, refusing any body that is not exactly the two pinned selectors

## 3. Verification

- [x] 3.1 Prove the replacement is target-free on all ten columns, at the next fence, and that the pinned operation becomes `DELETION_SUPERSEDED`
- [x] 3.2 Prove replay enqueues no second delete
- [x] 3.3 Prove every refusal boundary, and that the preflight agrees on each
- [x] 3.4 Confirm the tests catch a broken fix — loosening the `local-gated` clause fails the provider-safety test
- [x] 3.5 Full CI integration set green (127/127), unit suite green (1184/1184), `tsc` and `eslint` clean

## 4. Documentation

- [x] 4.1 Document the procedure in the runbook, stating that correcting the cell alone does not unstick a delete
- [x] 4.2 Record the falsified premise in `correct-diverged-cell-release` rather than leaving it reading as complete

## 5. Apply to the stranded tenant

- [x] 5.1 Supersede the stranded delete for tenant `1809ce5c` and confirm the replacement reaches `succeeded`
  - Applied in production 2026-08-19T09:34Z. The pinned operation became `failed_terminal` / `DELETION_SUPERSEDED` at fence 2, the target-free replacement was enqueued at fence 3, and the ordinary reconciler carried it `pending` → `billing-quiesced` → `succeeded` at checkpoint `destroyed` in under five minutes. Deployment-lock admission never saw a `runtimeTarget` to reject, exactly as the shape predicts.
- [x] 5.2 Confirm the routable set is empty and the capacity slot released
  - Tenant `deleted`, its cell `deleted`, zero routable cells, zero occupied capacity allocations, and `reserved_runtime_slots` back to 0 of 4.
- [x] 5.3 Confirm a promotion probe set can then be built, which it cannot while that cell is routable
  - `reviewer_bootstrap.py preflight` against candidate `eb88eedb` (0.54.1) is green on all four visible gates with `routable=0` and four runtime slots free, and the fifth gate it warns about but cannot see — a reviewer-purpose tenant holding a bound cell — is now provably clear: no reviewer tenant has a non-deleted cell, there are no ghost routable rows, and no lifecycle operation anywhere is unfinished.
