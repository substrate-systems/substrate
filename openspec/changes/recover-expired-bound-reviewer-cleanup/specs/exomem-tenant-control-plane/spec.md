## ADDED Requirements

### Requirement: An expired successful reviewer provision can be cleaned up exactly

An authenticated operator MAY use the existing expired-reviewer cleanup actions for one caller-pinned marketplace-reviewer V2 `provision` operation that succeeded at `bound` before its immutable reviewer assignment expired or was terminally failed. The service SHALL derive the tenant and cell only from that source operation, SHALL require the exact current fence, immutable reviewer-purpose tenant and assignment lineage, one matching active/provider-backed/ready bound cell whose full observed runtime identity and routable observation match the source target, and no live assignment, bootstrap, or conflicting lifecycle authority, and SHALL execute the existing atomic full-authority revocation plus higher-fence target-free tenant deletion. Residual tenant-bound credentials, sessions, transfer grants, or OAuth grants SHALL be revoked inside that same locked transaction rather than making the tenant ineligible. It MUST fail closed for a customer tenant, caller-supplied tenant/cell/volume selector, restore, legacy or incomplete operation, stale fence, multiple or mismatched cells, non-ready or non-routable cell, runtime observation mismatch, active assignment or bootstrap authority, or any other bound lifecycle state. The action MUST NOT extend assignment authority, manufacture client evidence, edit provider state, release capacity, or mark deletion complete.

#### Scenario: Successful expired reviewer provision is recovered

- **WHEN** an authenticated operator pins the exact `succeeded/bound` reviewer provision and current tenant fence after its matching reviewer assignment is expired or exactly terminal-failed
- **AND** the reviewer-purpose tenant has exactly one active, provider-backed, desired-running, `CELL_READY` cell which is both the source cell and bound cell, with an exact matching routable runtime observation and no live assignment, bootstrap authority, lease, or conflicting current-fence operation
- **THEN** the existing recovery transaction revokes the complete Hosted/reviewer/OAuth authority set, gates product state, advances the fence once, enqueues one source-derived target-free delete, and writes the principal-bound source/result receipt
- **AND** only normal provider-verified DESTROY can complete deletion and release capacity

#### Scenario: Successful-bound recovery preflight is content free

- **WHEN** an authenticated operator preflights the exact successful provision operation and expected fence
- **THEN** the service evaluates the same bound-reviewer predicates without mutation and returns only eligibility plus request metadata

#### Scenario: Ordinary or ambiguous bound tenant is refused

- **WHEN** the source or derived state names a non-reviewer tenant, a restore or incomplete operation, another fence, more than one live cell, a cell not exactly bound and routable with `CELL_READY`, an active assignment or bootstrap authority, or another unfinished operation
- **THEN** recovery refuses without changing tenant, cell, route, volume, operation, authority, entitlement, export, audit, or capacity state

#### Scenario: Successful-bound recovery is replayed exactly

- **WHEN** the same recovery is retried after the tenant advanced to exactly the next fence and one target-free delete with the source-derived key exists
- **THEN** the unchanged `succeeded/bound` source identifies that same delete and the service returns it as replayed
- **AND** it does not advance the fence, revoke authority, or enqueue destruction again

#### Scenario: Bound reviewer authority races recovery

- **WHEN** assignment, reviewer credential/session, magic-link session, transfer-grant, or OAuth authority issuance overlaps successful-bound recovery
- **THEN** canonical cohort-then-reviewer locking serializes every issuer with recovery and no usable authority commits after the deletion gate
- **AND** session resolution and transfer consumption independently refuse deletion-pending, deleted, or account-blocked tenants
