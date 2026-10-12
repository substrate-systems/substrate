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

An auto-registered CIMD client that has held a grant SHALL be retired once it is disabled
and its metadata has been expired for the configured lapsed connector grace period. One that
has never held a grant SHALL be retired once it is disabled and its last registration is
older than the configured idle client grace period. A generic client SHALL be disabled and
retired once it has held none of the authority above for the idle client grace period,
measured from its registration and from the last creation, renewal or revocation of any of
its grants.

Each partition's bound SHALL be stored as data that an operator changes without a schema
migration, and a partition without a stored bound SHALL admit no new client.

The token endpoint SHALL answer `invalid_client` for a client identifier that names no
client, or names a retired one, and SHALL answer both cases alike.

When a refresh needs an auto-registered client's lapsed metadata, the token endpoint SHALL
fetch the metadata document again with the same checks as at authorization, only for a live
refresh token of that client. If the fetch or a check fails, the token endpoint SHALL answer
a retryable server error, not `invalid_grant`, and SHALL leave the refresh token unspent.
After a bounded number of failed fetches for one client identifier within a window, the
token endpoint SHALL give such refreshes the same answer without a fetch until the window
ends. A successful fetch SHALL NOT count toward that bound. If another request's fetch made
the metadata fresh after this refresh's rotation was refused, the token endpoint SHALL rotate
again rather than refuse. A refresh token that is not live SHALL still be answered
`invalid_grant`.

A retired client that returns SHALL reuse its own record, and SHALL need a free slot in its
partition like a new client, so that revival can never take a partition past its bound.

The provenance partition SHALL be unchanged: the three partitions keep separate bounds, and
reclaim SHALL NOT move a slot between them.

#### Scenario: An expired auto-registered client returns its slot

- **WHEN** an auto-registered client's metadata has been expired beyond the lapsed connector grace period
- **THEN** the sweep retires it in addition to disabling it
- **AND** the auto-registered partition reports one more slot free
- **AND** the operator and generic partitions' headroom is unchanged

#### Scenario: A connector that never connected returns its slot within a day

- **WHEN** an auto-registered client that never held a grant has been disabled, and its last registration is older than the idle client grace period
- **THEN** the sweep retires it, without waiting for the longer grace of a connector that held a grant

#### Scenario: An operator changes a bound

- **WHEN** an operator changes a partition's stored bound
- **THEN** the next admission in that partition uses the new bound, without a migration
- **AND** the headroom report shows it

#### Scenario: A retired client asks for a token

- **WHEN** a client whose registration retired, or that was never registered, exchanges a code or a refresh token
- **THEN** the token endpoint answers `invalid_client`, so a client that registers dynamically registers again

#### Scenario: A connector's lapsed metadata is fetched again at refresh

- **WHEN** an auto-registered client presents a refresh token while its metadata has lapsed
- **THEN** the token endpoint fetches the metadata again only if the refresh token is live, and then rotates it
- **AND** if the fetch or a check fails, the token endpoint answers a retryable server error, and the refresh token stays unspent

#### Scenario: A returning client id reuses its own record

- **WHEN** a retired client id registers again from an admitted host while its partition has a free slot
- **THEN** its existing record is revived rather than a second record created
- **AND** it takes that one free slot

#### Scenario: A returning client finds its partition full

- **WHEN** a retired client id registers again while its partition is full
- **THEN** registration is refused as for a new client, and the record stays retired

#### Scenario: An idle generic client returns its slot

- **WHEN** a generic client has held no grant, code, token or authorization in progress for the idle client grace period
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
