## 1. Control-plane correction

- [x] 1.1 Add `preflightCorrectDivergedCellRelease` and `correctDivergedCellRelease` to `operator-controls.ts`, taking the target identity only from a terminal assignment on the pinned candidate
- [x] 1.2 Move the cell's recorded release and its four observed digests, and the routable cell contract observation, in one statement
- [x] 1.3 Install exactly one active thirty-minute assignment on the pinned candidate in the same statement
- [x] 1.4 Write a content-free principal-bound audit receipt naming the corrected release
- [x] 1.5 Replay to the same assignment when the correction already committed

## 2. Operator boundary

- [x] 2.1 Expose both actions through the existing rate-limited operator admin route, refusing any body that is not exactly the four pinned selectors
- [x] 2.2 Validate the pinned release against a bounded pattern rather than accepting free text

## 3. Verification

- [x] 3.1 PostgreSQL integration coverage for the correction, the routable observation, the installed assignment, and the audit receipt
- [x] 3.2 Prove the repair is real by enqueueing the same operation before and after, and asserting the target it would send moves from the stale release to the served one
- [x] 3.3 Prove every refusal boundary, and that the preflight agrees with the correction on each
- [x] 3.4 Prove replay installs no second assignment
- [x] 3.5 Confirm the tests catch a broken fix — an assignment installed already-expired fails three of them, and a skipped routable update fails the first
- [x] 3.6 Register `postgres.integration.test.ts` in CI and repair the two stale fixtures that had been failing unobserved (a `live` candidate at release `test` can never match `live_target`, which requires a gateway digest from the known-contract set and a bound catalog cell at the same release)

## 4. Documentation

- [x] 4.1 Document the diagnosis in the runbook, leading with the absence of a provisioner operations row
- [x] 4.2 Make cluster-side confirmation of the served image a precondition, not a suggestion
- [x] 4.3 State that the assignment expires in thirty minutes, so the stuck operation must be re-issued in the same sitting

## 5. Apply to the stranded tenant

- [x] 5.1 Correct cell `c73e5620` from 0.50.0 to candidate `eb88eedb` (0.54.1), after confirming the serving image against the deployment lock
  - Applied in production 2026-08-19T07:30Z. The serving pod ran the lock's exact `components.runtime.image`; the cell, its four observed digests and the routable observation all moved to 0.54.1.
- [ ] 5.2 Re-issue the deletion for tenant `1809ce5c` and confirm it reaches `succeeded`
  - **This change cannot do it, and the premise that it could was wrong.** An operation copies its target at creation and the reconciler builds the request from the operation, not the cell, so the stranded delete still presents 0.50.0. A fresh delete cannot be minted either, because `consumeDeletionConfirmationAtomic` refuses a `deletion_pending` tenant. Moved to `supersede-stranded-cell-delete`, which restores the tenant to the target-free delete shape admission cannot reject.
- [ ] 5.3 Confirm the routable set is empty and capacity is released before provisioning the alpha tenants
  - Now known to be load-bearing rather than tidiness: promotion health-probes every routable cell and requires every probe to succeed, and this cell yields no probe at all (its origin provision is at the old fence and the old candidate). Measured `probeable_ops = 0` on 2026-08-19.
