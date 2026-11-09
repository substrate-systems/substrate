## ADDED Requirements

### Requirement: Substrate signs a deletion grant when it deletes a cell

When the control plane sets a cell's `desired_state` to `deleted`, it SHALL sign a deletion grant in the same transaction and store it in `exomem_cloud_cells.deletion_grant`. The grant SHALL be an Ed25519 JWT whose payload is exactly `aud`, `iat`, `jti`, `cell_id` and `purge_after`, with `aud` equal to `exomem-cell-delete` and `purge_after` equal to `iat` plus the seven-day deletion grace. The grant SHALL carry no `exp`. The signature key SHALL be `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY`, apart from the operation grant key. cellctl's role SHALL read the column and SHALL hold no write on it or on `deletion_stopped_at`. While no key is configured, the deletion SHALL still commit and the row SHALL keep a NULL grant. A grant SHALL never sit on a live cell.

#### Scenario: A cell deletion stores a grant

- **WHEN** the reconcile or the invite expiry sets a cell's `desired_state` to `deleted` with the key configured
- **THEN** the row stores a grant that verifies against the public key
- **AND** the grant names that cell, carries no `exp`, and sets `purge_after` to `iat` plus seven days

#### Scenario: No key configured

- **WHEN** a cell is deleted while `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY` is unset or invalid
- **THEN** the deletion commits, the row keeps a NULL grant, and a value-free event is logged

#### Scenario: cellctl writes the grant column

- **WHEN** cellctl's role attempts UPDATE on `deletion_grant` or `deletion_stopped_at`
- **THEN** PostgreSQL rejects the write, including after the grants script runs again

#### Scenario: A stored grant is replaced or cleared

- **WHEN** an UPDATE changes or clears a cell's stored `deletion_grant`
- **THEN** PostgreSQL rejects the write

#### Scenario: A grant on a live cell

- **WHEN** a write sets `deletion_grant` on a cell whose `desired_state` is not `deleted`
- **THEN** PostgreSQL rejects the write

### Requirement: A cell's deletion is final

The database SHALL refuse any change to a deleted cell's `desired_state`, for every role. A DELETE of the row itself stays allowed. When a write reports `desired_state = 'deleted'` and `observed_state = 'deleted'` and `deletion_stopped_at` is not yet set, the database SHALL record `deletion_stopped_at` with its own clock; a later report SHALL NOT move it.

#### Scenario: A deleted cell is revived

- **WHEN** any role attempts to change a deleted cell's `desired_state`
- **THEN** PostgreSQL rejects the write

#### Scenario: cellctl's deleted report lands

- **WHEN** a write first makes a deleted cell's `observed_state` `deleted`
- **THEN** `deletion_stopped_at` records that moment
- **AND** a later report leaves it unchanged

### Requirement: The key watcher reads the deletion set

`GET /api/exomem/cell-deletions/<capability>` SHALL answer only the key-watcher receiver capability; the scheduler capability, any other token and an unconfigured ring SHALL get the alert receiver's 404. The body SHALL be `{"schema_version":1,"cells":[...]}` with exactly `cell_id`, `iat`, `purge_after` and `stopped_at` per cell, listing every cell deleted with a grant and no other cell. `iat` and `purge_after` SHALL come from the stored grant's own claims, and `stopped_at` SHALL be the recorded stop time or null. A stored grant that does not decode to integer claims SHALL fail the response rather than return a partial set.

#### Scenario: The scheduler capability asks

- **WHEN** the endpoint is called with the scheduler receiver capability
- **THEN** it answers 404 and names no cell

#### Scenario: The watcher reads the set

- **WHEN** the endpoint is called with the key-watcher capability
- **THEN** it returns every cell deleted with a grant, each with its grant's `iat` and `purge_after` and its recorded `stopped_at` or null
- **AND** a live cell and a grant-less deleted cell do not appear
