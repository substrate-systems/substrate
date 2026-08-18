## 1. Control-plane state and bookkeeping (substrate)

- [ ] 1.1 Clear `routable` on the tenant-destroy terminal checkpoint in `lifecycle-store.ts`, so a destroyed cell leaves the routable set
- [ ] 1.2 Add a PostgreSQL integration test proving a destroyed tenant's cell is absent from the routable set and that promotion's routable digest moves accordingly
- [ ] 1.3 Add the `rollforward` operation kind, with a migration for any operation-kind constraint or enum
- [ ] 1.4 Extend the routable observation write so a rollforward operation upserts `exomem_routable_cell_contracts` for the **same** `cell_id`, keyed on `(cell_id, profile_id)`
- [ ] 1.5 Allow assignment activation from a rollforward operation without an `expected_previous_cell_id`, preserving every existing digest equality check
- [ ] 1.6 Reject a rollforward whose target release is older than the cell's recorded release, with a stable content-free code
- [ ] 1.7 Fail routing closed for a cell between its authorized transition and verified completion

## 2. Provisioner lifecycle action (exomem)

- [ ] 2.1 Add a `rollforward` driver action that runs `helm upgrade` against the pinned chart with the lock's runtime target, under `--atomic --wait`
- [ ] 2.2 Carry the authorized target through the operation rather than reading it from the cell; reuse the provisioning fence and idempotency key
- [ ] 2.3 Implement the post-upgrade confirmation read and require exact equality with the authorized release, protocol, command fingerprint, schema and compatibility digests
- [ ] 2.4 Roll the cell back to its prior revision and fail terminal when confirmation does not match
- [ ] 2.5 Teach the in-memory provider to accept a governed rollforward, keeping `MetadataConflict("fixed Helm values drifted during adoption")` for unauthorized drift
- [ ] 2.6 Implement checkpoints `claimed → migrated → upgraded → verified → recorded → complete`, each idempotent on replay

## 3. Privileged migration step (exomem)

- [ ] 3.1 Add a `migrate` workload mode to the cell chart rendering a bounded, TTL'd root-capable Job with the same capability set as the init Job
- [ ] 3.2 Declare per-release whether a privileged tree migration is required, and render the Job only when the target declares one
- [ ] 3.3 Require the migration Job to succeed before the serving pod is moved to the target image
- [ ] 3.4 Verify no privileged Job is rendered for a plain image bump, and that the serving container's capabilities are unchanged in both cases

## 4. Wire protocol and lock

- [ ] 4.1 Add the `rollforward` operation to the provisioner wire protocol and its strict wire models
- [ ] 4.2 Confirm `expand` admission continues to admit both the forward target and `legacyCatalog` for a part-rolled fleet
- [ ] 4.3 Publish a provisioner image and compose a deployment lock naming it

## 5. Verification

- [ ] 5.1 Unit and integration coverage for every scenario in `specs/hosted-cell-rollforward/spec.md`
- [ ] 5.2 Prove data preservation by fingerprinting the vault before and after a rollforward, allowing only derived indexes to differ
- [ ] 5.3 Prove a cell that misreports its release cannot get a contract identity recorded for it
- [ ] 5.4 Prove replay safety by resuming an operation after the runtime moved and after the observation was written
- [ ] 5.5 Roll one canary tenant in production and confirm the recorded release moves with the runtime

## 6. Reconcile the existing divergence

- [ ] 6.1 Decide whether reconciling an already-diverged cell is in scope for the operation or needs a separate repair path (see design Open Questions)
- [ ] 6.2 Correct tenant `1809ce5c`, which serves 0.54.1 while recorded as 0.50.0 after the 2026-08-18 out-of-band upgrade
- [ ] 6.3 Confirm the routable set digest afterwards matches the live fleet before any promotion is attempted
