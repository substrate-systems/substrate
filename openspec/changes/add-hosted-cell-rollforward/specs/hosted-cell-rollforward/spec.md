## ADDED Requirements

### Requirement: Rollforward moves a cell in place and preserves its data

A rollforward operation SHALL move an existing hosted cell to a newer Exomem runtime
release without changing the cell identity, its bound volume, or its vault contents. The
tenant binding MUST remain unchanged throughout, and the operation MUST NOT provision a
successor cell.

#### Scenario: Cell moves to the target release

- **WHEN** a rollforward operation completes against a bound, ready cell
- **THEN** the cell serves the target release from the same `cell_id` and the same volume
- **AND** the tenant binding names that same cell before and after

#### Scenario: Vault contents survive the move

- **WHEN** a cell is rolled forward
- **THEN** every vault file present before the move is byte-identical afterwards, except
  derived indexes the runtime rebuilds on open

#### Scenario: Upgrade fails mid-flight

- **WHEN** the runtime upgrade fails to become ready within its bounded wait
- **THEN** the cell is returned to its prior runtime revision
- **AND** the operation records a stable content-free failure code without altering the
  recorded contract identity

### Requirement: The rollforward target is operator authorized and never self asserted

The target release, protocol, command fingerprint, schema digest, and compatibility digest SHALL be carried by the operator-authorized operation, fenced exactly as provisioning is. A cell MUST NOT be able to originate, widen, or alter the contract identity recorded for it.

#### Scenario: Operation carries the authorized target

- **WHEN** a rollforward operation is created
- **THEN** it names an exact target drawn from the governed deployment lock's runtime
  target and an operator-authorized contract candidate

#### Scenario: Cell advertises a release nobody authorized

- **WHEN** a cell advertises a release, fingerprint, or digest set that no active operation
  authorized
- **THEN** no contract identity is recorded for that cell on the strength of its own claim

### Requirement: The cell must confirm the target before the record moves

After the runtime is upgraded, the operation SHALL read the cell's advertised release,
protocol version, command fingerprint, schema digest, and compatibility digest and require
each to equal the authorized target before writing the routable cell observation. The
observation MUST be written for the same `cell_id` that was rolled forward.

#### Scenario: Cell agrees with the authorized target

- **WHEN** the upgraded cell advertises exactly the authorized release and digest set
- **THEN** the routable cell observation for that `cell_id` is updated to the target
- **AND** the cell becomes admissible under that release without any further operation

#### Scenario: Cell disagrees with the authorized target

- **WHEN** the upgraded cell advertises any release, fingerprint, or digest that differs
  from the authorized target
- **THEN** the operation rolls the cell back and fails terminal
- **AND** the previously recorded contract identity is left unchanged

#### Scenario: Operation replays after recording

- **WHEN** a reconciler resumes a rollforward whose observation was already written
- **THEN** the observation upsert is idempotent for that `cell_id` and the operation
  completes without a second runtime transition

### Requirement: Declared root migrations run before the serving runtime moves

When the target release declares a privileged tree migration, the operation SHALL execute
it as a bounded, TTL'd, root-capable job before the serving pod is moved to the target
image. The serving runtime MUST NOT be granted those capabilities, and no migration job may
be rendered for a target that declares none.

#### Scenario: Target declares a migration

- **WHEN** the target release declares a privileged tree migration
- **THEN** the migration runs to success as a separate bounded job before the serving pod
  is moved
- **AND** the serving container's own capability set is unchanged

#### Scenario: Migration fails

- **WHEN** the declared migration job fails or exceeds its bound
- **THEN** the serving runtime is left on its prior release
- **AND** the operation fails with a stable content-free code

#### Scenario: Target declares no migration

- **WHEN** the target release declares no privileged migration
- **THEN** no privileged job is rendered and the move is a plain runtime transition

### Requirement: Rollforward is forward only

A rollforward operation SHALL reject a target older than the cell's currently recorded
release. Returning a tenant to an earlier release is the restore path and MUST NOT be
reachable through rollforward.

#### Scenario: Target is older than the current release

- **WHEN** a rollforward names a target release earlier than the cell's recorded release
- **THEN** the operation is refused before any runtime transition with a stable code

### Requirement: Destroying a tenant clears its routable observation

Destroying a tenant SHALL clear the routable flag on that cell's contract observation, so
no dead cell remains in the routable set. Promotion live-probes every routable cell, so a
retained row for a destroyed cell blocks all future promotion.

#### Scenario: Tenant is destroyed

- **WHEN** a tenant destruction operation reaches its terminal destroyed checkpoint
- **THEN** the routable cell contract observation for that cell is no longer routable

#### Scenario: Promotion after a destruction

- **WHEN** a cohort promotion is attempted after a tenant has been destroyed
- **THEN** the routable set contains only live cells and the destroyed cell is absent

### Requirement: Operators can reconcile complete fleet authority before mutation

The control plane SHALL expose an authenticated, read-only, transactionally coherent
fleet observation containing routable contract observations, tenant-to-cell bindings,
active rollout assignments, unfinished lifecycle operations, capacity claims, and
reviewer-purpose state. The observation SHALL contain only opaque cell and operation
identifiers plus exact runtime identities and bounded state codes; it MUST NOT contain an
owner identifier, email, credential, browser token, note title, vault path, or tenant
content.

#### Scenario: Empty control-plane fleet is observed

- **WHEN** no active binding, routable cell, assignment, unfinished operation, capacity claim, reviewer authority, or reviewer-purpose tenant exists
- **THEN** the observation returns each authority set explicitly as empty and reports zero active capacity claims

#### Scenario: A ghost or unfinished transition exists

- **WHEN** any routable cell lacks an active binding or any assignment, lifecycle operation, capacity claim, or reviewer-purpose tenant remains
- **THEN** the observation includes that exact opaque state so the cross-repository inventory can refuse an unsafe upgrade phase
