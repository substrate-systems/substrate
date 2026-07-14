## ADDED Requirements

### Requirement: Public routing derives the tenant from authenticated identity

The Exomem gateway SHALL authenticate the public product session or API credential and resolve its authoritative account-to-tenant-to-cell mapping before examining command arguments. No public URL, body, query, cookie, or caller-supplied header MAY select or override the tenant, cell, vault root, or private endpoint.

#### Scenario: Authenticated owner invokes a command

- **WHEN** an authenticated owner with one active mapping invokes a known Exomem command
- **THEN** the gateway forwards only to that owner's mapped ready cell

#### Scenario: Caller supplies a tenant selector

- **WHEN** a request includes a tenant ID, cell ID, private endpoint, trusted-routing header, or equivalent selector controlled by the caller
- **THEN** the gateway rejects or strips it before routing according to the reserved-field contract
- **AND** the value never changes the resolved destination

#### Scenario: Mapping is missing or ambiguous

- **WHEN** identity resolution produces zero or more than one eligible destination
- **THEN** routing fails closed with a stable content-free error
- **AND** the gateway does not reuse a recent, default, or neighboring cell

### Requirement: Gateway command behavior is derived from Exomem's versioned registry

The gateway SHALL consume a versioned Exomem registry contract containing command names, parameter schemas, read/write metadata, result/error envelopes, capability metadata, and compatibility data. It MUST NOT maintain a hand-copied command allowlist or reimplement Exomem command coercion and governance.

#### Scenario: Contract command is forwarded

- **WHEN** a requested command is present in the compatible contract and the tenant is entitled
- **THEN** the gateway forwards the canonical command name and caller arguments to the cell's registry-backed route

#### Scenario: Unknown command is requested

- **WHEN** the command is absent from the cell's exposed contract
- **THEN** the gateway rejects it without substituting an alias or invoking another command

#### Scenario: Gateway and cell protocol are incompatible

- **WHEN** contract negotiation finds no supported version or digest relationship
- **THEN** the cell is treated as unavailable for that request and no command executes

### Requirement: Private forwarding authenticates and binds cell context

Every gateway-to-cell request SHALL use the destination cell's unique service credential over the configured private transport and SHALL include trusted cell identity, protocol, request ID, and opaque principal scope. The public Authorization header MUST NOT be forwarded, and the cell's private credential or address MUST NOT be returned.

#### Scenario: Valid private forwarding succeeds

- **WHEN** the gateway uses the mapped cell's credential and matching trusted context
- **THEN** the cell may evaluate the command through its normal registry and mutation boundary

#### Scenario: Credential for another cell is used

- **WHEN** a request to one cell carries another cell's valid credential or identity context
- **THEN** the destination rejects it before resolving a vault path or command leaf
- **AND** the gateway returns no content or metadata from either tenant

### Requirement: Entitlements are checked before forwarding

For every operation, the gateway SHALL require a current provider-neutral entitlement decision that permits the command capability and resource bounds. It MUST NOT call Paddle during normal command execution or forward Paddle identifiers to the cell.

#### Scenario: Capability is granted

- **WHEN** the entitlement grants the command and applicable resource limit
- **THEN** the gateway may forward provider-neutral capabilities and limits to the mapped cell

#### Scenario: Capability is absent or tenant is suspended

- **WHEN** the entitlement denies the command or a manual suspension is active
- **THEN** the gateway rejects before contacting the cell with a stable entitlement or suspension code

### Requirement: Idempotency is scoped to principal and tenant end to end

The gateway SHALL accept a bounded public idempotency key only from an authenticated request, preserve it across retry, and combine it with opaque principal scope and cell identity at the mutation boundary. Identical public keys used by different principals or tenants MUST remain independent.

#### Scenario: Mutation acknowledgement is lost

- **WHEN** a mutation completes but the gateway loses the response and retries the same command, canonical arguments, principal, cell, and key
- **THEN** the cell returns the recorded result without executing the mutation twice

#### Scenario: Same key is used by two tenants

- **WHEN** two tenants send the same public key for their own mutations
- **THEN** each operation has an independent idempotency namespace and neither can receive or suppress the other's result

#### Scenario: Key is reused with different input

- **WHEN** one scoped principal reuses a key for another command or payload
- **THEN** the governed `IDEMPOTENCY_KEY_REUSED` error is preserved
- **AND** the previous result is not disclosed

### Requirement: Retries never change tenant destination

The gateway SHALL retry only the originally resolved cell and only according to command read/write metadata. Reads MAY receive bounded transport retries; mutations MUST have stable idempotency before automatic retry. No failure path MAY select another cell.

#### Scenario: Mapped cell is unavailable

- **WHEN** a private request fails because the mapped cell is unavailable
- **THEN** the gateway returns a stable unavailable response after any bounded same-cell retry
- **AND** no other cell endpoint is contacted

#### Scenario: Mutation has no stable retry key

- **WHEN** a write encounters an ambiguous transport failure without an authenticated idempotency key
- **THEN** the gateway does not automatically replay it

### Requirement: Hosted transfer grants are short lived and tenant bound

The gateway SHALL issue signed transfer grants bound to an authenticated principal scope, tenant, cell, upload or download operation, hosted-transfer audience, issue/expiry time, unique grant identity, and resource limits. A grant MUST NOT contain or reveal a cell credential or private endpoint.

#### Scenario: Authorized upload grant is used

- **WHEN** a signed-in owner presents an unexpired upload grant and the same current tenant/cell mapping
- **THEN** the gateway enforces its size limits and streams only to that cell's governed upload boundary

#### Scenario: Grant is replayed against another tenant

- **WHEN** a grant issued for one cell is presented from a session or route resolving another cell
- **THEN** it is rejected before file existence, content, or metadata is disclosed

#### Scenario: Transfer scope or lifetime is wrong

- **WHEN** an upload grant is used for download, a download grant is used for upload, or the grant is expired
- **THEN** the transfer is rejected before reading or writing tenant data

### Requirement: Gateway errors and logs do not cross content boundaries

Gateway responses SHALL preserve governed Exomem result/error envelopes and stable codes without adding tenant-specific content. Operational logs MUST omit command arguments, query text, titles, paths, excerpts, public tokens, service credentials, transfer grants, email, and Paddle identifiers.

#### Scenario: Cell returns a governed validation error

- **WHEN** the cell returns a structured validation, authorization, writer, retry, or stale-write error
- **THEN** the gateway preserves its stable code and safe envelope

#### Scenario: Sensitive sentinel appears in request and cell error

- **WHEN** a command contains a sensitive sentinel and the cell fails
- **THEN** the sentinel is absent from gateway logs, transport diagnostics, and control-plane error records

### Requirement: Concurrent tenant requests remain isolated

The gateway SHALL keep routing, principal, entitlement, idempotency, transfer, response, and telemetry context request-local under concurrency.

#### Scenario: Two cells use identical paths and titles concurrently

- **WHEN** two authenticated tenants concurrently capture or read identical relative paths, titles, and idempotency key strings with distinct sentinel content
- **THEN** each request reaches only its mapped cell and receives only its own result
- **AND** neither tenant's sentinel appears in the other's response, replay state, error, or log context
