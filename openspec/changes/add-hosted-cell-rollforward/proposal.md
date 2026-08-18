## Why

A hosted cell keeps the Exomem runtime it was born with. The provisioner exposes no
upgrade or migrate action, and `_provision` installs only when the release is absent, so
every existing tenant is pinned to its provisioning release forever. Today the only way to
move a tenant forward is blue-green replacement or destruction — and ordinary destruction
strands a `routable = true` row for a dead cell, which permanently blocks every future
cohort promotion.

This is not survivable for a product that ships releases regularly: the private alpha is
about to onboard real people, and the next release would strand all of them.

The mechanics are already in place. On 2026-08-18 the live alpha cell was upgraded
0.50.0 → 0.54.1 in production with `helm upgrade --reuse-values`: a three-line manifest
diff, 26 seconds, zero restarts, and a byte-identical vault. What is missing is not
infrastructure — it is a governed operation, and the control-plane bookkeeping that makes
an upgrade *count*.

## What Changes

- Add a `rollforward` lifecycle operation that moves an existing cell to the deployment
  lock's current runtime target **in place**, preserving the cell identity, its volume, and
  its data. It reuses the existing leased/checkpointed operation machinery.
- Write the routable cell observation for the **same** `cell_id` on rollforward. Today
  `exomem_routable_cell_contracts` is only ever written by the *replacement* path, so an
  in-place upgrade is invisible to admission no matter how correct the running cell is.
- Activate a pending rollout assignment from a rollforward operation, without requiring a
  successor cell. Assignment activation is currently reachable only through an operation
  carrying `expected_previous_cell_id`.
- Run the root-privileged tree migration step on rollforward when the target release
  declares one. The cell chart renders its root init Job only when
  `workloadMode == "initialize"`, so a serving cell never re-runs it — meaning a release
  whose fix is a root-run migration (0.54.1's ownership convergence is exactly this) does
  not reach already-provisioned tenants.
- Clear `routable` on the tenant-destroy path, so destroying a tenant stops stranding a
  ghost that blocks promotion. This is a pre-existing defect on the same code path and is
  in scope because rollforward is the feature that makes cell-state bookkeeping load
  bearing.
- Teach the in-memory lifecycle provider to distinguish a governed rollforward from
  accidental drift. It currently raises
  `MetadataConflict("fixed Helm values drifted during adoption")` for *any* Helm value
  change, which encodes cell immutability as a test invariant.

Not a breaking change: no existing operation kind, wire field, or admission predicate
changes meaning. Cells that are never rolled forward behave exactly as today.

## Capabilities

### New Capabilities

- `hosted-cell-rollforward`: moving an existing hosted cell to a new Exomem runtime
  release in place — authorization, ordering against the deployment lock, data and
  identity preservation, migration execution, failure and rollback behaviour, and the
  control-plane record that makes the new release admissible.

### Modified Capabilities

- `exomem-tenant-control-plane`: the enumerated set of leased, checkpointed, replay-safe
  lifecycle operations gains `rollforward`, and routing/readiness gating must fail closed
  for a cell mid-rollforward.

## Impact

**Security-relevant.** The control plane derives a cell's contract identity from
operator-authorized *intent*, never from asking the cell. Admission trusts that identity,
so a cell must not be able to assert its own release. Rollforward MUST therefore carry an
operator-authorized target through the same fenced operation path as provisioning, and
MUST NOT be implemented by observing a cell and recording whatever it reports.

- **substrate**: `lifecycle-store.ts` (operation kinds, routable observation, assignment
  activation, destroy-path `routable` clear), `agent-contract-canaries.ts`,
  `src/app/api/exomem/admin/contracts/route.ts`, a migration for any new operation-kind
  constraint, and the PostgreSQL integration suites.
- **exomem**: `infra/provisioner/src/exomem_provisioner/lifecycle.py` (new driver action
  and in-memory provider), the live Helm adapter, `infra/helm/cell/` for the migration
  step, and the provisioner wire protocol.
- **Operational**: per-cell downtime is a bounded blip, not zero — `replicas: 1` on an
  ReadWriteOnce volume means the old pod must release the mount before the new one starts.
  Cells are independent, so there is never a global maintenance window.
- **Sequencing**: fleet rolls happen under the deployment lock's `expand` admission mode,
  which admits the forward target plus everything in `legacyCatalog`; a `contract` lock is
  composed only once no cell is left behind.
