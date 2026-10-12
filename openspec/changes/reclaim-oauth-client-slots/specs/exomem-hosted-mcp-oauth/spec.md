## ADDED Requirements

### Requirement: A client population slot is reclaimable

The client population bound SHALL count only clients that have not been retired, in each
of its three partitions: operator-registered, auto-registered CIMD, and generic. A
first-party client SHALL take no slot and SHALL never be retired. A client that can never
be admitted again SHALL become retired, and retirement SHALL preserve the client record
rather than deleting it, so that a client's provenance — in particular whether it ever
carried reviewer bootstrap history — remains checkable after its slot is returned. A
retired client SHALL never be enabled.

Retirement SHALL be refused for any client that holds a grant that is not revoked, an
unexpired authorization code, access token or refresh token, or an authorization in
progress. The refusal SHALL be a query of that state, not a judgement of the client's age.

An auto-registered CIMD client SHALL be retired once it is disabled and its metadata has
been expired for a configured grace period. A generic client SHALL be disabled and retired
once it has held none of the authority above for a configured grace period, measured from
its registration and from the last creation, renewal or revocation of any of its grants.

A retired client that returns SHALL reuse its own record, and SHALL need a free slot in its
partition like a new client, so that revival can never take a partition past its bound.

The provenance partition SHALL be unchanged: the three partitions keep separate bounds, and
reclaim SHALL NOT move a slot between them.

#### Scenario: An expired auto-registered client returns its slot

- **WHEN** an auto-registered client's metadata has been expired beyond the retirement grace period
- **THEN** the sweep retires it in addition to disabling it
- **AND** the auto-registered partition reports one more slot free
- **AND** the operator and generic partitions' headroom is unchanged

#### Scenario: A returning client id reuses its own record

- **WHEN** a retired client id registers again from an admitted host while its partition has a free slot
- **THEN** its existing record is revived rather than a second record created
- **AND** it takes that one free slot

#### Scenario: A returning client finds its partition full

- **WHEN** a retired client id registers again while its partition is full
- **THEN** registration is refused as for a new client, and the record stays retired

#### Scenario: An idle generic client returns its slot

- **WHEN** a generic client has held no grant, code, token or authorization in progress for the generic retirement grace period
- **THEN** the sweep disables and retires it
- **AND** the generic partition reports one more slot free
- **AND** its client identifier is no longer admitted at any stage

#### Scenario: A live client keeps its slot

- **WHEN** retirement is evaluated for a client that holds a grant that is not revoked, an unexpired code, access token or refresh token, or an authorization in progress
- **THEN** retirement is refused and the client keeps its slot
- **AND** the refusal does not depend on how old the client is

#### Scenario: A retired bootstrap client stays unusable

- **WHEN** a client that carried reviewer bootstrap history is retired
- **THEN** it still cannot be enabled or repurposed
- **AND** its bootstrap provenance is still readable

#### Scenario: The first-party client is never reclaimed

- **WHEN** any path tries to retire the first-party client
- **THEN** the database refuses, and the client still takes no slot

#### Scenario: Exhaustion is visible before it blocks admission

- **WHEN** an operator reads control-plane state
- **THEN** the bound and use of each partition are reported as authoritative server state
- **AND** the reported bound is the one the database enforces, not a value restated by tooling

### Requirement: OAuth maintenance runs on a schedule

The control plane SHALL run OAuth maintenance from its scheduled reconcile job: delete
expired authorization transactions, codes and tokens, disable CIMD clients whose metadata
expired, and retire clients as the slot reclaim requirement states. Each run SHALL be
bounded. A failed run SHALL fail the scheduled job without stopping the job's other work.

#### Scenario: The scheduled job runs maintenance

- **WHEN** the reconcile job runs
- **THEN** the maintenance sweep runs beside billing and Cloud reconciliation
- **AND** the job reports how many clients it disabled and retired, without client identities

#### Scenario: Maintenance fails

- **WHEN** the maintenance sweep fails
- **THEN** billing and Cloud reconciliation still complete in that run
- **AND** the job answers with a failure, so the scheduler records and alerts on it
