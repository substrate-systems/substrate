## ADDED Requirements

### Requirement: A diverged cell's recorded runtime identity can be corrected under operator authority

An authenticated operator MAY move one caller-pinned cell's recorded release, observed gateway contract digest, observed command fingerprint, observed schema digest, and observed compatibility digest onto a cataloged contract candidate, and the service SHALL take that identity only from a terminal rollout assignment already minted for the same tenant on the same candidate, never composing any digest at the call site. The correction SHALL be atomic under the exclusive cohort lock, SHALL move the cell's routable contract observation with it, SHALL install exactly one active time-bounded assignment on that candidate, and SHALL persist a content-free principal-bound audit receipt naming the corrected release. It MUST fail closed for a tenant that is not reviewer-purpose, a tenant at a different fence than the caller pinned, a cell that is not the tenant's only live cell, a cell that is not bound or retiring, a cell missing any observed digest, a cell whose recorded release differs from the one the caller pinned, a candidate that is not cataloged or does not differ from what the cell records, an absent or still-live source assignment, any lifecycle operation in flight, or any preparing or active assignment. It MUST NOT call the provider, alter capacity, alter the tenant fence, or mark any operation complete.

#### Scenario: A diverged cell is corrected

- **WHEN** an authenticated operator pins a reviewer-purpose tenant's only live cell, its current fence, the release that cell records, and a cataloged candidate that differs from it and carries a terminal assignment for the same tenant
- **THEN** one atomic transaction moves the cell's recorded release and its four observed digests onto that assignment's identity, moves the routable observation to match, installs one active assignment bounded to thirty minutes, and writes a principal-bound audit receipt naming the corrected release
- **AND** the provider is not called and capacity is unchanged

#### Scenario: A corrected cell can mint an admissible operation

- **WHEN** a lifecycle operation is enqueued for that tenant after the correction commits
- **THEN** it derives its target from the installed active assignment rather than the cell's origin provision, and carries the corrected release, protocol version and gateway contract digest
- **AND** before the correction the same enqueue carries the stale identity that the deployment lock refuses

#### Scenario: Correction preflight is content free

- **WHEN** an authenticated operator preflights the same pinned cell, candidate, expected release and expected fence
- **THEN** the service evaluates the same eligibility boundary without mutation and returns only eligibility plus request metadata

#### Scenario: Correction eligibility differs

- **WHEN** the pinned tenant is not reviewer-purpose, the pinned fence is stale, the pinned current release does not match what the cell records, the candidate matches what the cell already records, the tenant has another live cell, an operation is in flight, or an assignment is preparing or active
- **THEN** correction refuses without changing cell, routable observation, assignment, audit, capacity, or operation state

#### Scenario: Correction is replayed

- **WHEN** the same authenticated correction request is retried after its transition committed
- **THEN** a separate replay branch requires the cell to already record that candidate's identity, one active unexpired assignment on it, and the prior audit receipt
- **AND** it returns the same assignment without installing another
