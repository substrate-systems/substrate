## ADDED Requirements

### Requirement: A client population slot is reclaimable

The client population bound SHALL count only clients that have not been retired. A client
that can never be admitted again SHALL become retired, and retirement SHALL preserve the
client record rather than deleting it, so that a client's provenance — in particular
whether it ever carried reviewer bootstrap history — remains checkable after its slot is
returned.

Retirement SHALL be refused for any client that is enabled, or that has a live grant,
access token, or refresh token.

The provenance partition SHALL be unchanged: operator-registered and auto-registered
clients keep separate bounds, and reclaim SHALL NOT move a slot between them.

#### Scenario: An expired auto-registered client returns its slot

- **WHEN** an auto-registered client's metadata has been expired beyond the retirement grace period
- **THEN** the sweep retires it in addition to disabling it
- **AND** the auto-registered partition reports one more slot free
- **AND** the operator partition's headroom is unchanged

#### Scenario: A returning client id reuses its own record

- **WHEN** a retired client id registers again from an admitted host
- **THEN** its existing record is revived rather than a second record created
- **AND** the partition count does not increase

#### Scenario: A spent bootstrap client returns its slot

- **WHEN** a reviewer OAuth bootstrap authority is consumed or revoked
- **THEN** the pinned client it burned is retired as well as disabled and versioned
- **AND** that client still cannot be enabled or repurposed
- **AND** its bootstrap provenance is still readable

#### Scenario: A live client keeps its slot

- **WHEN** retirement is evaluated for a client that is enabled, or that holds any live grant or token
- **THEN** retirement is refused and the client keeps its slot
- **AND** the refusal does not depend on how old the client is

#### Scenario: Exhaustion is visible before it blocks admission

- **WHEN** an operator reads control-plane state
- **THEN** the headroom of each partition is reported as authoritative server state
- **AND** the reported bound is the one the database enforces, not a value restated by tooling
