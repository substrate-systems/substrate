## Context

Hosted tenants each run a private Exomem cell: a `replicas: 1` StatefulSet on a
ReadWriteOnce volume, installed by the provisioner as a Helm release (stored with the
ConfigMap driver, which is why `helm list -A` does not show it). The image comes from
`runtime_image_for`, which returns the provisioner's configured runtime target from the
governed deployment lock — fixed at provision time.

Two facts were established in production on 2026-08-18 and shape every decision here.

First, the Helm mechanics already work. Upgrading the live alpha cell 0.50.0 → 0.54.1
with `helm upgrade --reuse-values --set image=… --set expectedRelease=…` produced a
three-line manifest diff (image, `exomem.io/expected-release` annotation, release env),
completed in 26 seconds under `--atomic --wait`, and left the vault byte-identical — 41
files, 662023 bytes, the only change being the derived `Knowledge Base/.graph.sqlite`,
which rewrites pages on open.

Second, that upgrade did not count for anything. `exomem_routable_cell_contracts` — whose
contents form the routable set digest promotion compares against — is written from
`owned.target_*`, the rollout assignment's target candidate, inside a statement driven by
a provisioning operation. Nothing probes the cell. The control plane still records 0.50.0
for a cell demonstrably serving 0.54.1.

That asymmetry is the design problem: the runtime is trivially movable, and the *record*
of it is not movable at all except by replacing the cell.

## Goals / Non-Goals

**Goals:**

- Move an existing cell to a new runtime release without changing its identity, its
  volume, or its data.
- Make the resulting release admissible — the control-plane record must move with the
  runtime, or the upgrade is cosmetic.
- Preserve the property that a cell cannot assert its own contract identity.
- Reuse the existing leased, checkpointed, replay-safe operation machinery rather than
  inventing a second lifecycle path.
- Stop tenant destruction from stranding a routable ghost.

**Non-Goals:**

- Per-cell zero downtime. With `replicas: 1` on an RWO volume the old pod must release the
  mount before the new one starts, so a bounded blip of tens of seconds is inherent.
  Reaching zero would need RWX storage or a two-cell handover with a routing cutover —
  a large change for a single-writer vault.
- Downgrade. Rollforward moves forward only; recovering a bad release is the existing
  restore/replacement path.
- Fleet orchestration policy (batching, canary percentages, pacing). This change adds the
  per-cell operation; who calls it and in what order is deliberately left to the operator
  and a later change.
- Changing how the deployment lock is composed or how `expand`/`contract` admission works.

## Decisions

### In-place upgrade, not blue-green replacement

The control plane already has a replacement path (`expected_previous_cell_id`) that
retires a prior cell and is the only place that clears `routable`. Reusing it for version
bumps was considered and rejected: replacement on an RWO volume means either a volume
handoff or a full export/restore cycle per tenant per release, and it churns `cell_id` on
every upgrade — invalidating the tenant binding, the routable set digest, and any
in-flight operation, for a change that touches one container image.

In-place keeps `cell_id`, the PVC, and the binding stable. The cost is that we now need a
second writer of the routable observation, which replacement previously monopolised.

### The target comes from the operation, never from the cell

Admission trusts the recorded contract identity. If rollforward worked by probing a cell
and recording whatever it advertised, any cell that could be made to misreport its release
would admit itself into a cohort it does not satisfy. So the operation carries an
operator-authorized target — the same shape provisioning already carries — through the
same fenced path.

### Trust the intent, but require the cell to agree before recording

The two previous decisions are in tension: we must not take the cell's word for what to
record, yet recording pure intent would let the record run ahead of reality exactly as it
currently lags behind it.

Resolution: intent *authorizes* and observation *confirms*. After the Helm upgrade the
operation reads the cell's advertised release, protocol, command fingerprint, schema and
compatibility digests and requires them to equal the authorized target. Equal, and the
routable observation is written for the same `cell_id`. Not equal, and the operation rolls
back and fails terminal without writing. The cell can therefore veto a claim about itself
but can never originate one.

### A distinct `migrate` workload mode for root-run migrations

The cell chart renders its root init Job only when `workloadMode == "initialize"`. That is
why the upgrade is clean — no Job immutability problem — and also why a release whose fix
is a root-run tree migration never reaches an existing tenant. 0.54.1 is precisely this
case: its ownership convergence runs as root with `CHOWN, DAC_OVERRIDE, FOWNER`, and the
cell itself runs as uid 10001 and cannot chown anything.

Running the migration inside the cell's own entrypoint was rejected: it would require the
serving container to hold root or those capabilities permanently, which is the opposite of
the current posture. Instead the chart gains a `migrate` workload mode rendering a Job with
the same bounded capabilities and TTL as the init Job, run only when the target release
declares a migration, and required to succeed before the serving pod is moved.

### Checkpoints mirror the existing operation model

`claimed → migrated → upgraded → verified → recorded → complete`. Each step is idempotent
on replay: a Helm upgrade already at the target revision is a no-op, verification is a
read, and the observation write is an upsert keyed on `(cell_id, profile_id)`. This
satisfies the existing requirement that a reconciler resuming from a verified checkpoint
does not unsafely replay completed destructive work.

### Fix the destroy-path ghost in this change

Destroying a tenant leaves `routable = true` for a dead cell, and promotion live-probes
every routable cell, so a single destroyed tenant blocks all future promotions. It is a
pre-existing defect, but it lives on the same bookkeeping surface this change makes load
bearing, and leaving it would mean shipping a release process that is still one tenant
deletion away from being stuck.

## Risks / Trade-offs

- **Per-tenant downtime during the roll** → Inherent to `replicas: 1` on RWO; bounded to
  tens of seconds, cells are independent, and there is never a global window. Sequence the
  fleet rather than parallelising it.
- **A root-capable migration Job is reintroduced on the upgrade path** → Same bounded
  capabilities and TTL as the existing init Job, gated on the target release declaring a
  migration, and never rendered for a plain image bump.
- **Mixed releases across the fleet mid-roll** → Already solved by the deployment lock's
  `expand` mode, which admits the forward target plus `legacyCatalog`. Compose a
  `contract` lock only once no cell is left behind.
- **Rollforward used to move a cell backwards** → Reject a target older than the cell's
  current recorded release; recovery is the restore path, which has its own verification.
- **Verification passes but the cell crashloops later** → Readiness and desired-state
  routing gates still apply independently; a recorded observation is not a routing
  decision.
- **Two writers of the routable observation** → Both are upserts keyed on
  `(cell_id, profile_id)` under the same cohort advisory lock; replacement clears the
  prior cell's row, rollforward updates in place, and they cannot both own one cell.

## Migration Plan

1. Land the substrate side (operation kind, observation write, assignment activation,
   destroy-path clear) behind the existing operator-only admin surface.
2. Land the exomem side (driver action, in-memory provider, chart `migrate` mode) and
   publish a provisioner image; compose a deployment lock naming it.
3. Roll one canary tenant, verify the recorded release moves and the vault fingerprint is
   unchanged apart from derived indexes.
4. Roll the remaining fleet in sequence under `expand`.
5. Compose a `contract` lock once no cell is left behind.

Rollback: `helm upgrade --atomic` self-reverts a failed cell upgrade; a cell already moved
can be returned with `helm rollback` to its prior revision, and the control-plane record is
corrected by re-running rollforward against the earlier target only if that target is still
in the lock's catalog.

## Open Questions

- Does rollforward require a pre-created rollout assignment, or should the operation create
  one implicitly? Requiring one keeps canary semantics explicit; creating one implicitly
  makes a fleet roll a single call per tenant.
- Should rollforward be operator-initiated per tenant, or driven by the reconciler once the
  deployment lock's runtime target moves? The latter is closer to "seamless" but removes the
  operator's per-tenant gate.
- **Concrete first case:** tenant `1809ce5c` was upgraded out of band on 2026-08-18 and is
  now serving 0.54.1 while recorded as 0.50.0. The first rollforward against it will be a
  no-op at the Helm layer but must still correct the record. This is a useful acceptance
  case, and it should be decided whether reconciling an already-diverged cell is in scope
  for the operation or needs a separate repair path.
