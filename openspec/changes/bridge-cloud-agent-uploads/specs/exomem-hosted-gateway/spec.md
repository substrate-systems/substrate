## ADDED Requirements

### Requirement: Cloud upload handoffs preserve their originating authority

The gateway SHALL bind each upload handoff to the authenticated tenant, cell, client, grant, login generation and exact OAuth resource.
The cell SHALL retain the complete authorization binding with its single-use ticket.
Caller-supplied routing or origin headers SHALL NOT establish authority.

#### Scenario: An agent prepares an original file upload

- **WHEN** an admitted Cloud MCP client requests a held Source upload with an expected SHA-256
- **THEN** the cell issues its existing single-use ticket under the verified originating authority
- **AND** the response retains the portable handoff fields defined by `capture-agent-files`
- **AND** no Source is committed

#### Scenario: A capsule and ticket come from different logins

- **WHEN** a client combines one login's valid routing capsule with another login's ticket
- **THEN** the cell refuses the mismatch before consuming the ticket or receiving bytes
- **AND** no held file is created

### Requirement: The gateway revalidates delegated upload authority before receiving bytes

The fixed gateway `/upload` route SHALL validate its signed routing capsule and recheck current OAuth admission and revocation before reading the body.
It SHALL resolve the destination from current authority and require the cell's write state.
It SHALL forward only to that cell's fixed upload route with fresh private origin proof.

#### Scenario: Authority is revoked after ticket issuance

- **WHEN** a ticket's login family is revoked, its client is no longer admitted, or its tenant is blocked
- **THEN** the gateway refuses before reading application body bytes or contacting a cell

#### Scenario: The cell does not admit writes

- **WHEN** a valid delegated upload targets a stopped, read-only or deleted cell
- **THEN** the gateway refuses the upload without treating the transfer tools' availability as write authority

### Requirement: A Cloud upload preserves the existing held-file boundary

Cloud uploads SHALL enforce the ticket's byte limit while streaming, including requests without Content-Length.
The receiver SHALL verify the expected SHA-256 before holding bytes and consume a ticket at most once.
It SHALL return the existing held handle without committing a Source.
Only capture by the matching current authorization binding SHALL produce a custody receipt.

#### Scenario: Two uploads race with the same ticket

- **WHEN** two valid requests present the same single-use ticket
- **THEN** at most one request receives its held-file result
- **AND** the other request creates no second hold

#### Scenario: Bytes exceed the cap or differ from the expected original

- **WHEN** a stream exceeds the ticket's limit or its SHA-256 differs from the caller's assertion
- **THEN** the receiver refuses without a held handle or Source custody claim

#### Scenario: The reply is lost after receiving bytes

- **WHEN** an upload's outcome is uncertain after a connection failure
- **THEN** the client reports uncertainty without automatically replaying the consumed capability
- **AND** abandoned held bytes remain subject to the existing expiry

### Requirement: Cloud handoffs survive the existing client and egress contracts

The Cloud handoff SHALL preserve the personal descriptor's field meanings, lifetime cap and byte cap.
Its capability SHALL survive mandatory output scrubbing and fit the CLI's bounded descriptor input.
The additive Cloud format SHALL NOT change personal ticket parsing or weaken credential scrubbing.
OAuth and cell bearers SHALL remain private.

#### Scenario: A coding agent uses the handoff file

- **WHEN** an agent sends the actual MCP result to the CLI's handoff mode
- **THEN** the CLI sends the original bytes to the fixed HTTPS gateway endpoint without another credential
- **AND** the resulting held handle can be captured only under its originating binding

### Requirement: Upload enablement follows compatible deployment proof

Cloud upload issuance SHALL remain disabled by default and apply only to selected compatible cells.
Cloud SHALL retain the transfer exclusion until the gateway, CLI, receiver and capture workflow is verified.
Disabling issuance SHALL prevent new handoffs while preserving existing receipts and bounded held-file cleanup.

#### Scenario: The bridge has not been enabled

- **WHEN** a Cloud client requests an upload handoff on an unselected or incompatible deployment
- **THEN** it receives the existing unavailable result
- **AND** no public route exposes a cell listener or filesystem path
