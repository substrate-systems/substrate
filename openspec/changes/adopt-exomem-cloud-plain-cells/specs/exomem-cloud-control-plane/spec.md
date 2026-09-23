## ADDED Requirements

### Requirement: Admission to Exomem Cloud needs only an invite, an entitlement and capacity

Redeeming a valid Cloud invite SHALL create the tenant, its entitlement and one `exomem_cloud_cells` row, once invite validity, account blocks, tenant uniqueness and published capacity allow it. Published capacity is the sum of `cell_slots` over `exomem_cloud_capacity`, and the check counts non-deleted cell rows.

- The row's `desired_state` SHALL follow the entitlement mapping: `running` for an active complimentary invite, and `stopped` for a paid invite still awaiting checkout.
- Admission MUST NOT depend on a live cohort, contract candidate, rollout assignment, client artifact, capacity-pool reservation or any existing cell.
- The capacity check SHALL run before any write-bearing statement, under a transaction-scoped lock.
- When capacity is exhausted, admission SHALL answer with a typed, retryable refusal that leaves the invite unconsumed.
- A row whose tenant is still awaiting checkout after 7 days SHALL be set to `deleted`.

#### Scenario: First user on an empty fleet

- **WHEN** the first complimentary invite is redeemed on an installation with zero cells and published capacity
- **THEN** a tenant, an entitlement and one cell row with `desired_state = running` are created

#### Scenario: Capacity is exhausted

- **WHEN** an invite is redeemed while non-deleted cell rows equal the published capacity
- **THEN** the response is `HOSTED_ADMISSION_CLOSED` (503, retryable)
- **AND** the invite remains valid and unconsumed, and no tenant, entitlement or cell row is written

#### Scenario: Concurrent redemption at the last free slot

- **WHEN** two invites are redeemed concurrently while exactly one slot is free
- **THEN** exactly one admission succeeds and the other receives `HOSTED_ADMISSION_CLOSED` with its invite unconsumed

#### Scenario: Paid invite before checkout

- **WHEN** a paid invite is redeemed and checkout has not completed
- **THEN** the cell row has `desired_state = stopped`, and no cell resources exist for it
- **AND** the row becomes `running` when checkout activates the entitlement

#### Scenario: Unpaid invite expires

- **WHEN** a tenant remains awaiting checkout for 7 days
- **THEN** its cell row's `desired_state` becomes `deleted`, releasing the slot

### Requirement: Cloud OAuth clients are admitted by approved host, not by cohort

For the Cloud MCP resource, an OAuth client SHALL be admitted when it is enabled, its redirect URI matches its registered digest, and its CIMD metadata host is approved and fresh. Admission MUST NOT require a live cohort or a reviewer credential.

- An access token SHALL be bound to exactly one resource, and a token SHALL be accepted only where its resource is exactly equal to the resource being served.
- A token for the Cloud resource SHALL be issued only to a principal that owns a non-deleted cell row.

#### Scenario: claude.ai connects on an empty cohort

- **WHEN** claude.ai presents CIMD metadata from an approved host, with no contract candidate or client artifact present
- **THEN** authorization proceeds to consent and issues a Cloud-resource token after the invite-backed sign-in

#### Scenario: Unapproved host

- **WHEN** a client's CIMD metadata host is not approved
- **THEN** authorization is refused before consent

#### Scenario: Token presented to the other resource

- **WHEN** a token bound to the hosted resource is presented to the Cloud gateway, or a Cloud-resource token to the hosted path
- **THEN** the request is refused as unauthenticated and reaches no cell

### Requirement: The Cloud gateway is an authenticated pass-through

The Cloud gateway SHALL:

- authenticate the access token for the Cloud resource;
- apply IP rate limits, keyed on the client address recorded by our own ingress;
- apply identity rate limits and concurrency guards;
- derive the tenant and cell only from the authenticated principal;
- forward the MCP request and stream the response to that cell's internal service without buffering.

It SHALL forward only `content-type`, `accept`, `mcp-session-id` and `mcp-protocol-version`, adding `x-request-id`. It SHALL authenticate to the cell with a per-cell bearer derived from a key it holds. It MUST NOT forward the client's `Authorization` header, cookies or forwarding headers, and MUST NOT fetch or compare a contract.

It SHALL answer `GET` with 405. It SHALL proxy only while the cell row's `desired_state` is `running` or `read_only`.

It SHALL answer with a typed 503 `CELL_NOT_READY`:

- when the cell row's desired state is anything else;
- when the cell cannot be reached.

It SHALL answer with a typed 502 `CELL_AUTH_MISMATCH` when the cell rejects the derived bearer.

#### Scenario: Tool call reaches the owner's cell

- **WHEN** an authenticated client calls a tool through the gateway
- **THEN** the request reaches only the cell mapped to the principal, carrying the derived cell bearer
- **AND** the response streams back with `private, no-store`

#### Scenario: Caller attempts to select another cell

- **WHEN** a request carries a path, query or header naming a different tenant or cell
- **THEN** the gateway rejects the selector, or ignores it and routes only by the principal

#### Scenario: Cell is stopped

- **WHEN** the principal's cell row has `desired_state = stopped`
- **THEN** the gateway answers 503 `CELL_NOT_READY` without contacting any cell

#### Scenario: Cell is starting

- **WHEN** the principal's cell row is `running` but its pod is not yet accepting connections
- **THEN** the gateway answers 503 `CELL_NOT_READY`

#### Scenario: Bearer key mismatch

- **WHEN** the cell answers the derived bearer with 401
- **THEN** the gateway answers 502 `CELL_AUTH_MISMATCH` and does not relay the cell's response body

#### Scenario: GET on the MCP endpoint

- **WHEN** a client sends `GET` to the Cloud MCP path
- **THEN** the gateway answers 405 without contacting any cell

### Requirement: Cloud cell lifecycle is written as desired state

Every lifecycle transition of a Cloud tenant SHALL be expressed only as an update to its cell row's `desired_state`, and each update SHALL increment `generation` and notify the controller. The mapping from the effective entitlement SHALL be:

- `running` while writes are allowed (active, trialing, complimentary active);
- `read_only` while reads are allowed and writes are denied (grace, provider-paused, cancelled);
- `stopped` while reads are denied (manually suspended, complimentary revoked);
- `deleted` on account deletion.

The control plane MUST NOT call a provisioner, claim a lifecycle lease or hold a fence for Cloud cells.

#### Scenario: Payment enters grace

- **WHEN** a Cloud tenant's entitlement becomes `past_due`
- **THEN** its cell row's `desired_state` becomes `read_only`, and `generation` increases

#### Scenario: Entitlement restored

- **WHEN** a `read_only` tenant's payment succeeds
- **THEN** its cell row's `desired_state` becomes `running`

#### Scenario: Manual suspension

- **WHEN** the operator suspends a Cloud tenant
- **THEN** its cell row's `desired_state` becomes `stopped`

#### Scenario: Account deletion

- **WHEN** a Cloud tenant deletes their account
- **THEN** its cell row's `desired_state` becomes `deleted`
- **AND** only a content-free receipt is retained once the controller reports `deleted`

### Requirement: A Cloud release is one setting

The Cloud release SHALL be the `cell_image` digest in `exomem_cloud_settings`, which the owner sets through an owner-only route. Releasing MUST NOT require importing a candidate, promoting a cohort or committing per-release fixtures. The owner route SHALL also:

- clear a paused `exomem_cloud_rollout`;
- set or clear a single row's `desired_image`.

#### Scenario: Owner releases a new runtime

- **WHEN** the owner sets `cell_image` to a new digest
- **THEN** the setting is stored, and no other release artifact is required

#### Scenario: Owner resumes a paused rollout

- **WHEN** the rollout is paused and the owner clears it
- **THEN** `exomem_cloud_rollout.paused` becomes false, and its error code and held cell are cleared

#### Scenario: Non-owner attempts a release

- **WHEN** a signed-in non-owner calls the release route
- **THEN** the route refuses, and no setting changes

### Requirement: The application runs on standard PostgreSQL

Every database access SHALL go through a driver that works against standard PostgreSQL over TLS with verify-full, through a transaction-mode pooler. No module SHALL depend on a provider-specific HTTP query endpoint. The driver SHALL provide tagged-template queries, `query(text, params)` with optional full results, and an atomic transaction of several statements that commits all of them or none.

#### Scenario: Application against a vanilla Postgres

- **WHEN** the application and its test suite run against a standard PostgreSQL server
- **THEN** Exomem, Endstate and account queries succeed with the same results as before the driver change

#### Scenario: Transaction failure

- **WHEN** one statement in a transaction fails
- **THEN** no statement in that transaction is committed

### Requirement: Database roles are least-privilege and granted idempotently

Migrations SHALL run as the schema-owning role, through a separate migration connection. The application SHALL run as a role that does not own the schema.

The gateway and controller roles SHALL receive only the privileges their contracts name:

- the gateway may write rate-limit buckets;
- the controller may write only the observed columns of the cell rows.

Grants SHALL live in an idempotent script, applied after migrations and after any restore.

#### Scenario: Controller attempts a desired-state write

- **WHEN** the controller role attempts to update `desired_state`
- **THEN** the database refuses the statement

#### Scenario: Grants after restore

- **WHEN** the database is restored from a dump taken without owners or ACLs, and the grants script runs
- **THEN** every role has exactly its named privileges, and a second run changes nothing

### Requirement: Cutover from the managed database loses no write

The cutover SHALL freeze the source database against writes before the dump, so that a late write fails instead of being silently lost. The cutover SHALL verify per-table row counts and checksums before switching traffic, and SHALL keep the source read-only as the rollback until retirement.

#### Scenario: A consumer writes during the window

- **WHEN** any consumer attempts a write to the source database after the freeze
- **THEN** the write fails, and the new database is not missing an acknowledged write
