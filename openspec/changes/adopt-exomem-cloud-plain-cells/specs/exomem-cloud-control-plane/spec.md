## ADDED Requirements

### Requirement: Admission to Exomem Cloud needs only an invite, an entitlement and capacity

Redeeming a valid Cloud invite SHALL create the tenant, its entitlement and one `exomem_cloud_cells` row with `desired_state = running`, once invite validity, account blocks, tenant uniqueness and the published capacity allow it. Admission MUST NOT depend on a live cohort, contract candidate, rollout assignment, client artifact or any existing cell. The capacity check SHALL run before any write-bearing statement, under a transaction-scoped lock. When capacity is exhausted, admission SHALL answer with a typed, retryable refusal that leaves the invite unconsumed.

#### Scenario: First user on an empty fleet

- **WHEN** the first invite is redeemed on an installation with zero cells and published capacity
- **THEN** a tenant, an entitlement and one cell row with `desired_state = running` are created

#### Scenario: Capacity is exhausted

- **WHEN** an invite is redeemed while non-deleted cell rows equal the published capacity
- **THEN** the response is `HOSTED_ADMISSION_CLOSED` (503, retryable)
- **AND** the invite remains valid and unconsumed, and no tenant, entitlement or cell row is written

### Requirement: Cloud OAuth clients are admitted by approved host, not by cohort

For the Cloud MCP resource, an OAuth client SHALL be admitted when it is enabled, its redirect URI matches its registered digest, and its CIMD metadata host is approved and fresh. Admission MUST NOT require a live cohort or a reviewer credential. An access token for the Cloud resource SHALL be issued only to a principal owning a non-deleted cell row.

#### Scenario: claude.ai connects on an empty cohort

- **WHEN** claude.ai presents CIMD metadata from an approved host, with no contract candidate or client artifact present
- **THEN** authorization proceeds to consent and issues a Cloud-resource token after the invite-backed sign-in

#### Scenario: Unapproved host

- **WHEN** a client's CIMD metadata host is not approved
- **THEN** authorization is refused before consent

### Requirement: The Cloud gateway is an authenticated pass-through

The Cloud gateway SHALL:

- authenticate the access token for the Cloud resource;
- apply IP and identity rate limits and concurrency guards;
- derive the tenant and cell only from the authenticated principal;
- forward the MCP request and stream the response to that cell's internal service without buffering.

It SHALL forward only an allowlisted set of MCP headers, and SHALL authenticate to the cell with a per-cell bearer derived from a key it holds. It MUST NOT forward the client's `Authorization` header, cookies or forwarding headers, and MUST NOT fetch or compare a contract. It SHALL refuse with a typed 503 when the principal's cell is not running and ready.

#### Scenario: Tool call reaches the owner's cell

- **WHEN** an authenticated client calls a tool through the gateway
- **THEN** the request reaches only the cell mapped to the principal, carrying the derived cell bearer
- **AND** the response streams back with `private, no-store`

#### Scenario: Caller attempts to select another cell

- **WHEN** a request carries a path, query or header naming a different tenant or cell
- **THEN** the gateway rejects the selector, or ignores it and routes only by the principal

#### Scenario: Cell is still provisioning

- **WHEN** the principal's cell row is not ready
- **THEN** the gateway answers 503 `CELL_NOT_READY` without contacting any cell

### Requirement: Cloud cell lifecycle is written as desired state

Suspension, resumption and deletion of a Cloud tenant SHALL be expressed only as updates to its cell row's `desired_state`, and each update SHALL increment `generation` and notify the controller. The control plane MUST NOT call a provisioner, claim a lifecycle lease or hold a fence for Cloud cells.

#### Scenario: Entitlement lapses

- **WHEN** a Cloud tenant's entitlement lapses
- **THEN** its cell row's `desired_state` becomes `stopped`, and `generation` increases

#### Scenario: Account deletion

- **WHEN** a Cloud tenant deletes their account
- **THEN** its cell row's `desired_state` becomes `deleted`
- **AND** only a content-free receipt is retained once the controller reports `deleted`

### Requirement: A Cloud release is one setting

The Cloud release SHALL be the `cell_image` digest in `exomem_cloud_settings`, which the owner sets through an owner-only route. Releasing MUST NOT require importing a candidate, promoting a cohort or committing per-release fixtures. The owner route SHALL also clear a paused rollout, and set or clear a single row's image override.

#### Scenario: Owner releases a new runtime

- **WHEN** the owner sets `cell_image` to a new digest
- **THEN** the setting is stored, and no other release artifact is required

### Requirement: The application runs on standard PostgreSQL

Every database access SHALL go through a driver that works against standard PostgreSQL over TLS with verify-full, through a transaction-mode pooler. No module SHALL depend on a provider-specific HTTP query endpoint.

#### Scenario: Application against a vanilla Postgres

- **WHEN** the application and its test suite run against a standard PostgreSQL server
- **THEN** Exomem, Endstate and account queries succeed with the same results as before the driver change
