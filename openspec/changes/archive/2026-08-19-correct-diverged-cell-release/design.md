# Design

## The failure this repairs

`_admit_submission` in the provisioner compares a v2 request's `runtimeTarget` against the deployment lock's active runtime with plain inequality:

```python
if "runtimeTarget" in request and request["runtimeTarget"] != policy.forward_target:
    raise AdmissionRejected("runtime target does not match deployment lock")
```

Substrate builds that target from the operation's `target_*` columns, which a non-provision operation derives from the cell's recorded identity. So the comparison is between a **fleet-wide, current** gate and a **per-cell, historical** record. Moving the lock forward is therefore not a safe unilateral act: it silently invalidates the lifecycle of every cell whose recorded release it leaves behind.

The rejection raises before any row is written, which is why the provisioner's `operations` table is empty for a failure of this kind. That absence is the cheapest diagnostic available and the runbook leads with it.

## Why the correction installs the assignment too

A delete's target comes from the first matching branch of a preference chain in `lifecycle-store.ts`. `bound_assignment_target` — an active, unexpired assignment joined against the cell's recorded release, protocol version and observed digests — outranks the origin provision. So:

- correcting only the cell removes the origin match (`operation.target_source_release = bound_cell.release_version` no longer holds) and puts nothing in its place, leaving *no* derivable target and an enqueue that fails as `IDEMPOTENCY_KEY_REUSED`;
- installing only the assignment leaves it unmatched against a cell still recording the old identity.

Either half alone is a worse stall than the divergence. They are one fact and are written in one statement.

`createCanaryAssignment` cannot supply the active assignment: it inserts `preparing`, and the only `preparing → active` transition lives in the provision path's `bound` checkpoint. A diverged cell cannot run a provision, so that path is unreachable by construction.

## Where the identity comes from

The candidate row carries release, protocol version, command fingerprint, schema digest and compatibility digest — but **not** the gateway contract digest. That digest lives on the rollout assignment. Rather than reconstruct it from the contract fixtures (which would let the control plane assert a contract nobody reviewed for this tenant), the correction requires a terminal assignment already minted for the same tenant on the same candidate and copies from it. In the incident that motivated this, that assignment already existed and matched the lock's active target byte-for-byte; it had merely expired.

This is also why the control is scoped to reviewer-purpose tenants. The assignment it copies from must itself be reviewer-purpose, which is the only shape the private alpha mints.

## What the control refuses to know

It does not verify that the runtime moved. It cannot: every provisioner request for a diverged cell carries the stale target, health included, so there is no admissible observation to make. The control asserts what the operator has confirmed against the cluster, and the runbook makes that confirmation — serving pod image versus the lock's `components.runtime.image` — a precondition rather than a suggestion.

What it does enforce is that the identity being recorded was genuinely minted and cataloged. An operator can be wrong about *whether* to correct; they cannot use this to record an identity that never existed.

## Preflight and correction duplicate their predicate

The reconciler does not take the cohort lock, so it can create a lifecycle operation between a preflight read and a later write. Only a predicate evaluated in the same statement as the mutation is sound, so the correction repeats the eligibility clauses inside its own CTE rather than calling the preflight helper. A stale preflight can therefore produce a refusal but never an unsafe write. The integration suite asserts the two agree across every refusal case, which is the practical guard against the duplication drifting.

## Open questions

- Whether the same shape should exist for customer tenants once the alpha is not reviewer-only. Deferred until there is a non-reviewer cell to correct.
- Whether the lock should carry a composed `rollback` runtime target as a matter of course. It was `null` during this incident, which removed the cheapest escape hatch — flipping `runtime_selection` — and forced a control-plane change instead. Tracked with `add-hosted-cell-rollforward`.
