## MODIFIED Requirements

### Requirement: Lifecycle operations are leased, checkpointed, and replay safe

Provision, suspend, resume, rotate, export, restore, rollforward, stop, and delete operations SHALL have durable idempotency keys, explicit states, bounded leases, retry metadata, and stable content-free failure codes. Two reconcilers MUST NOT advance the same checkpoint concurrently.

#### Scenario: Two reconcilers claim one operation

- **WHEN** concurrent workers attempt to claim the same runnable lifecycle operation
- **THEN** at most one owns the unexpired lease and performs the external transition

#### Scenario: Worker exits mid-operation

- **WHEN** a reconciler exits after an external step but before completion
- **THEN** the lease expires and a later reconciler resumes from a verified checkpoint without replaying completed destructive work unsafely

#### Scenario: Terminal configuration failure occurs

- **WHEN** an operation cannot proceed because required protocol or isolation configuration is invalid
- **THEN** it records `failed_terminal` with a stable code and does not retry indefinitely

#### Scenario: Reconciler resumes a rollforward after the runtime moved

- **WHEN** a reconciler resumes a rollforward whose runtime transition already completed
- **THEN** it continues from the verified checkpoint without performing a second runtime transition

### Requirement: Readiness and desired state gate routing

The control plane SHALL route only cells whose desired state, lifecycle state, private liveness, private readiness, entitlement, and protocol binding all permit the requested operation. Suspension, draining, restore, rollforward, and deletion states MUST fail closed.

#### Scenario: Ready cell serves a request

- **WHEN** the active cell is live, ready, protocol-compatible, unsuspended, and entitled for the operation
- **THEN** the gateway may forward that operation to the exact cell

#### Scenario: Cell is draining or unavailable

- **WHEN** the mapped cell is draining, quiesced, restoring, sealed, unavailable, or stale
- **THEN** the request receives a stable not-ready/unavailable response
- **AND** no alternate cell is tried

#### Scenario: Cell is mid-rollforward

- **WHEN** a cell is between its authorized rollforward transition and its verified completion
- **THEN** requests receive a stable not-ready/unavailable response
- **AND** no alternate cell is tried
