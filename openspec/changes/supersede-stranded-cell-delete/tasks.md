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

- [ ] 5.1 Supersede the stranded delete for tenant `1809ce5c` and confirm the replacement reaches `succeeded`
- [ ] 5.2 Confirm the routable set is empty and the capacity slot released
- [ ] 5.3 Confirm a promotion probe set can then be built, which it cannot while that cell is routable
