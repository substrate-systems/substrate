## Why

A hosted cell's recorded `release_version` pins the `runtimeTarget` of every lifecycle operation the tenant can mint, and the provisioner admits a v2 request only when that target is byte-equal to the deployment lock's active runtime. When a runtime is upgraded out of band, the control plane's record stays behind and the cell becomes impossible to quiesce, seal, or destroy: `_admit_submission` rejects the request before persisting it, so the failure reaches Substrate as a content-free 422, is classified non-retryable, and the operation goes `failed_terminal` on its first attempt with no row in the provisioner's own operations table to explain it.

No request shape escapes this. Health carries the same stale target, so the divergence cannot even be re-observed through the provisioner that caused it. On 2026-08-18 this stranded the deletion of tenant `1809ce5c`, whose cell serves 0.54.1 while recorded as 0.50.0.

Ordinary assignment activation cannot be reused as the repair, because it is reachable only from a succeeding provision — precisely what a diverged cell cannot run.

## What Changes

- Add one authenticated operator action, plus its read-only preflight, that moves a diverged cell's recorded release and observed digests onto a cataloged candidate the cell already serves.
- Copy that identity from a terminal rollout assignment already minted for the same tenant on the same candidate. That assignment is the only source of the gateway contract digest, which is absent from the candidate row; the action never composes one.
- Install one active, time-bounded assignment on that candidate in the same transaction, because a later operation derives its target from an active assignment matched against the cell's recorded identity. Correcting either fact alone leaves the tenant with no derivable target at all.
- Move the routable cell contract observation with the cell, so the correction does not trade one stale record for another.
- Require a caller-pinned cell, candidate, expected current release and expected tenant fence, and fail closed on a non-reviewer tenant, a cell that is not the tenant's only live cell, a candidate that does not differ from what the cell records, any in-flight operation, or any live assignment.
- Return only a content-free outcome plus the opaque assignment identity, and replay to the same result.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-tenant-control-plane`: Add a narrowly scoped operator-authorized correction of a cell's recorded runtime identity when the runtime it serves has moved out of band and the stale record has made every lifecycle operation inadmissible.

## Impact

- `src/lib/exomem-hosted/operator-controls.ts` gains the atomic eligibility, correction, and replay branches.
- `src/app/api/exomem/admin/contracts/route.ts` exposes both actions through the existing rate-limited operator boundary.
- `src/lib/exomem-hosted/__tests__/postgres.integration.test.ts` proves the correction, the resulting change in what a later operation would send to the provisioner, replay, and every refusal boundary.
- `.github/workflows/test.yml` runs that suite, which had never been registered and so had been failing unobserved.
- `docs/runbooks/exomem-hosted-alpha.md` gains the diagnosis, the cluster-side confirmation that must precede the correction, and the procedure.

## Non-goals

- Rolling a cell's runtime forward. That is `add-hosted-cell-rollforward`; this change answers its open question 6.1 by establishing the separate repair path that question asks for, and does not implement a `rollforward` operation kind.
- Observing the runtime through the provisioner. The action asserts that the runtime already moved and is deliberately dependent on an operator having confirmed that against the cluster, because no provisioner-mediated observation of a diverged cell is possible.
