# exomem-tenant-control-plane Specification

## Purpose

Define authoritative tenant-to-cell mapping and durable, replay-safe provisioning, lifecycle, export, restore, and deletion orchestration.

## Requirements

### Requirement: Account-to-cell mapping is authoritative and unambiguous

The control plane SHALL maintain an immutable normal-request mapping from one Exomem tenant to exactly one active isolated cell. Tenant and cell identifiers MUST be opaque server-generated values and MUST NOT be selected by a public caller.

#### Scenario: Ready tenant resolves its cell

- **WHEN** an authenticated owner has one ready tenant with one active cell
- **THEN** the control plane resolves that exact cell, release, private endpoint reference, and credential reference

#### Scenario: Mapping is absent or ambiguous

- **WHEN** a tenant has no active cell or more than one cell eligible for active routing
- **THEN** resolution fails closed with a stable content-free error
- **AND** no historical, neighboring, or default cell is selected

### Requirement: Cell credentials and endpoints remain private

Every cell SHALL have a unique rotatable private service credential. Credentials and private endpoints MUST be encrypted or held in an external secret boundary, MUST be decrypted only for private lifecycle or forwarding calls, and MUST never be returned to browsers, Paddle, analytics, email, or Exomem vault content.

#### Scenario: Cell is provisioned

- **WHEN** the control plane provisions a new cell
- **THEN** it generates a unique credential and stores only protected credential material plus an opaque provider reference

#### Scenario: Credential is rotated

- **WHEN** an authorized lifecycle operation rotates a cell credential
- **THEN** the new credential becomes authoritative through an atomic or overlap-safe transition
- **AND** the old credential is revoked without changing the public tenant mapping

### Requirement: Provisioning converges through durable desired state

Creating a tenant SHALL enqueue an idempotent lifecycle operation that converges one isolated cell with distinct vault, state, and log roots. The web request MUST NOT report a ready service until private readiness confirms the expected cell identity, protocol, release, mutation authority, and worker policy.

#### Scenario: Provisioning succeeds after retries

- **WHEN** repeated reconciler runs process the same tenant provisioning operation
- **THEN** provider calls use the same idempotency identity, one logical cell is created, and the operation advances through durable checkpoints to `succeeded`

#### Scenario: Provider acknowledgement is lost

- **WHEN** the provisioner creates a resource but the control-plane request times out before recording success
- **THEN** reconciliation queries or repeats the same idempotent operation and adopts the existing matching resource
- **AND** it does not create a second active cell

#### Scenario: Cell reports another identity

- **WHEN** a provisioned endpoint's private readiness response names a different cell or incompatible protocol
- **THEN** the operation fails closed and the endpoint is never bound for public routing

### Requirement: Lifecycle operations are leased, checkpointed, and replay safe

Provision, suspend, resume, rotate, export, restore, stop, and delete operations SHALL have durable idempotency keys, explicit states, bounded leases, retry metadata, and stable content-free failure codes. Two reconcilers MUST NOT advance the same checkpoint concurrently.

#### Scenario: Two reconcilers claim one operation

- **WHEN** concurrent workers attempt to claim the same runnable lifecycle operation
- **THEN** at most one owns the unexpired lease and performs the external transition

#### Scenario: Worker exits mid-operation

- **WHEN** a reconciler exits after an external step but before completion
- **THEN** the lease expires and a later reconciler resumes from a verified checkpoint without replaying completed destructive work unsafely

#### Scenario: Terminal configuration failure occurs

- **WHEN** an operation cannot proceed because required protocol or isolation configuration is invalid
- **THEN** it records `failed_terminal` with a stable code and does not retry indefinitely

### Requirement: Readiness and desired state gate routing

The control plane SHALL route only cells whose desired state, lifecycle state, private liveness, private readiness, entitlement, and protocol binding all permit the requested operation. Suspension, draining, restore, and deletion states MUST fail closed.

#### Scenario: Ready cell serves a request

- **WHEN** the active cell is live, ready, protocol-compatible, unsuspended, and entitled for the operation
- **THEN** the gateway may forward that operation to the exact cell

#### Scenario: Cell is draining or unavailable

- **WHEN** the mapped cell is draining, quiesced, restoring, sealed, unavailable, or stale
- **THEN** the request receives a stable not-ready/unavailable response
- **AND** no alternate cell is tried

### Requirement: Restore publishes a replacement cell atomically

Restoring a tenant SHALL stage and verify canonical data in a new isolated cell or volume, prove protocol/readiness, and atomically replace the active binding only after validation. Failure MUST leave the previous active cell binding unchanged.

#### Scenario: Restore succeeds

- **WHEN** a verified export is restored into an isolated staged root and the replacement cell becomes ready
- **THEN** the control plane atomically binds the tenant to the replacement and retires the previous cell through a later checkpoint

#### Scenario: Restore verification fails

- **WHEN** archive integrity, cell identity, protocol, or readiness validation fails
- **THEN** the staged replacement is quarantined or deleted
- **AND** the existing cell remains the sole active destination

### Requirement: Export is verified before delivery

The control plane SHALL quiesce the exact active cell, invoke Exomem's deterministic export, verify manifest integrity, store the archive in tenant-scoped encrypted object storage, resume according to prior desired state, and issue only a short-lived owner-scoped download reference.

#### Scenario: Owner requests an export

- **WHEN** an authenticated owner requests export and no equivalent operation is already complete
- **THEN** the system creates or returns an idempotent asynchronous operation and eventually exposes verified integrity metadata plus an expiring download action

#### Scenario: Export verification fails

- **WHEN** the cell output or object-store copy does not match its manifest and digest
- **THEN** no downloadable artifact is published and the cell is safely resumed or left in an operator-visible recoverable state

### Requirement: Exomem deletion is complete, product scoped, and externally verified

Deleting Exomem SHALL require fresh owner confirmation, revoke Exomem sessions and transfers, suspend routing, seal the cell, apply final-export policy, destroy tenant compute, storage, backup objects, and encryption keys through the provisioner, remove the active binding, and mark Exomem state deleted. It MUST NOT delete shared identity or Endstate product data.

#### Scenario: Confirmed deletion completes

- **WHEN** an owner consumes a valid fresh deletion confirmation and every destructive checkpoint is externally verified
- **THEN** the tenant becomes deleted, no Exomem route or transfer remains usable, and only minimum content-free audit proof remains

#### Scenario: Storage destruction is still pending

- **WHEN** compute is stopped but volume, backup, or tenant-key destruction has not been verified
- **THEN** the operation remains pending or retryable
- **AND** Home and APIs do not claim deletion is complete

#### Scenario: User also has Endstate data

- **WHEN** that user deletes Exomem
- **THEN** their shared identity and Endstate credentials, subscriptions, and backups remain unchanged

### Requirement: Lifecycle observability is content free

Control-plane lifecycle and provisioner logs SHALL contain only opaque identifiers, request/operation IDs, transition names, stable codes, release/protocol, timing, and safe resource buckets. They MUST NOT contain vault queries, titles, paths, excerpts, email, secrets, transfer grants, Paddle identifiers, or provider credentials.

#### Scenario: Provider returns a content-bearing error

- **WHEN** a downstream lifecycle response includes a sensitive sentinel
- **THEN** the persisted and logged error is reduced to an allowlisted stable code and request reference
- **AND** the sensitive downstream text is not returned to the user
