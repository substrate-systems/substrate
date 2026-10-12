## ADDED Requirements

### Requirement: Outstanding invitations count against Cloud capacity

The control plane SHALL compute free Cloud capacity as fresh Cloud slots minus live cells minus outstanding invitations. An outstanding invitation is an unexpired, unrevoked start link or operator invitation of any kind, including complimentary, covered and reviewer invitations. Start, waitlist promotion, redemption and invitation creation SHALL read this value under one advisory lock. Stale capacity observations MUST admit nobody new. The retired Hosted capacity pool MUST NOT gate admission.

#### Scenario: Two requests compete for the last place

- **WHEN** two new addresses ask for the last free place at the same time
- **THEN** one receives a start link and the other joins the waitlist

#### Scenario: Outstanding invitations hold places

- **WHEN** a start link or an operator invitation of any kind is outstanding
- **THEN** its place counts as taken until the invitation is redeemed, expires or is revoked

#### Scenario: Operator invites when Cloud is full

- **WHEN** an operator creates a complimentary, paid or reviewer invitation while no place is free
- **THEN** the system refuses with a stable capacity response and creates no invitation

#### Scenario: Capacity observations are stale

- **WHEN** the newest Cloud capacity observation is older than its freshness limit
- **THEN** the system admits nobody

### Requirement: The unpaid hold runs from admission

The seven-day hold for an owner who redeemed an invitation and has not paid SHALL start at the creation of the stopped cell, not at the creation of the tenant. A re-admission MUST start a full new hold.

#### Scenario: Returning person is re-admitted

- **WHEN** a tenant created months ago is re-admitted with a new stopped cell
- **THEN** the hold expires seven days after that cell was created, not on the next sweep

#### Scenario: First admission

- **WHEN** a new tenant redeems an unpaid invitation
- **THEN** the hold expires seven days after its stopped cell was created

### Requirement: Export requests are content-free rows with split authority

Export requests SHALL be stored as content-free rows under the tenant's cell. Substrate SHALL write the request columns only. The cell controller SHALL write the observation columns only. The gateway MUST have no access. The database SHALL allow at most one open export for each cell. The cell controller SHALL take a hold of kind `export` that stops the cell on every storage class while the export runs, and SHALL derive the object key only from the row's cell and export identifiers.

#### Scenario: Roles cross the ownership boundary

- **WHEN** Substrate writes an observation column, the cell controller writes a request column, or the gateway reads the table
- **THEN** PostgreSQL rejects the operation

#### Scenario: Two requests race for one cell

- **WHEN** two exports are requested for one cell at the same time
- **THEN** at most one open row exists

#### Scenario: Another tenant names the export

- **WHEN** a session of tenant B names an export of tenant A
- **THEN** the API answers 404 and reveals nothing

#### Scenario: Stopped cell is exported

- **WHEN** a stopped cell is exported
- **THEN** the cell stays at zero replicas and its runtime never starts during the export

### Requirement: Export archives expire and the cell controller deletes them

The cell controller SHALL mark an export ready only after it checks the uploaded part count, the part digest and the object size. When the export expires or a new export replaces it, the controller SHALL delete every object version, clear the link fields and mark the row expired. On failure or deadline the controller SHALL abort the upload, release the hold and record a failure code.

#### Scenario: Export reaches its time limit

- **WHEN** the export's expiry time passes
- **THEN** every stored object version is gone and the row is `expired`

#### Scenario: Uploaded part was substituted

- **WHEN** the part digest or object size does not match the report
- **THEN** the export fails and no download link is ever issued

#### Scenario: Export job cannot finish

- **WHEN** the job fails or passes its deadline
- **THEN** the upload is aborted, the hold is released and the row shows a failure code

### Requirement: Home reaches its cell with a short-lived first-party token

Substrate SHALL call the owner's cell only through the public Cloud MCP address, with an access token that it mints for each call for a first-party Home client. The token MUST be bound to the session's tenant, last at most 120 seconds, carry only the read and write scopes, stay in server memory and never be logged. The module SHALL make exactly two calls: `configure_memory` and `bootstrap` with the `activity` section. No request SHALL carry a tenant or cell identifier.

#### Scenario: Cell is stopped or not ready

- **WHEN** the cell's desired state is neither running nor read-only, or the cell is not ready
- **THEN** the call returns `unavailable` with a reason and makes no network request

#### Scenario: Token belongs to one tenant

- **WHEN** a Home token minted for tenant A reaches the gateway
- **THEN** it resolves only to tenant A's cell

#### Scenario: Account is blocked or deleted

- **WHEN** the account is blocked or its deletion has begun
- **THEN** the gateway refuses a Home token that was minted earlier

### Requirement: The first-party Home client is marked by data and is not an app

A database column SHALL mark the first-party Home client. The marker MUST decide whether a client appears in the app list and counts as a slot. Code MUST NOT identify the Home client by its id.

#### Scenario: Home client is excluded

- **WHEN** the system lists apps or counts client slots
- **THEN** the first-party Home client is neither listed nor counted

### Requirement: Storage use is an observation, not a plan limit

The cell controller SHALL record used bytes, filesystem bytes and the observation time from every backup and export job report. The status poll SHALL read only these stored values. It SHALL report storage as known with the values and the observation time, or as unknown.

#### Scenario: Backup reports usage

- **WHEN** a backup job reports the used and total bytes of the volume
- **THEN** the cell row stores both values and the time

#### Scenario: Cell was never measured

- **WHEN** no job has reported usage for a cell
- **THEN** the status poll reports storage as unknown

#### Scenario: Report is impossible

- **WHEN** a report has used bytes above the filesystem size or a filesystem size of zero
- **THEN** the database refuses the row
