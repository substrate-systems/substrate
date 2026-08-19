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

### Requirement: A permanently inadmissible tenant delete can be superseded by a target-free one

An authenticated operator MAY supersede one caller-pinned tenant delete that admission can never accept, and the replacement SHALL be a target-free delete carrying `cell_id`, `expected_previous_cell_id`, and every `target_*` column NULL so that no `runtimeTarget` is presented to the provisioner. The supersession SHALL be atomic under the exclusive cohort lock, SHALL advance the tenant fence exactly once, SHALL terminalize the pinned operation as `DELETION_SUPERSEDED`, SHALL end any preparing or active rollout assignment for that tenant, and SHALL persist a content-free principal-bound audit receipt linking the superseded and replacement operations. It MUST fail closed unless the pinned operation is a `delete` that is `failed_terminal` with `PROVISIONER_REJECTED` at checkpoint `local-gated`, carries a cell and a target candidate on wire protocol v2, is unleased and completed, and sits at the caller-pinned fence which the tenant also holds; and unless the tenant is reviewer-purpose, deletion-pending, desired-deleted, not yet deleted, and has exactly one live cell with no other unfinished operation. It MUST NOT call the provider, alter capacity, or mark any deletion complete.

#### Scenario: A stranded delete is superseded

- **WHEN** an authenticated operator pins a reviewer-purpose tenant's delete that is terminal with `PROVISIONER_REJECTED` at `local-gated`, at the tenant's current fence
- **THEN** one atomic transaction advances the tenant fence by one, marks the pinned operation `failed_terminal` with `DELETION_SUPERSEDED`, ends any live assignment, enqueues one delete at the new fence whose cell and every target column are NULL, and writes principal-bound receipts for both the supersession and the replacement
- **AND** the provider is not called and capacity is unchanged

#### Scenario: The replacement is admissible where the original was not

- **WHEN** the replacement operation is dispatched by the ordinary reconciler
- **THEN** it presents no `runtimeTarget`, so deployment-lock admission has nothing to compare and cannot reject it for a mismatched runtime
- **AND** the tenant destroy still marks every cell of the tenant deleted and clears its routable observation

#### Scenario: Supersession preflight is content free

- **WHEN** an authenticated operator preflights the same pinned operation and expected fence
- **THEN** the service evaluates the same eligibility boundary without mutation and returns only eligibility plus request metadata

#### Scenario: An operation that reached the provider is refused

- **WHEN** the pinned operation sits at any checkpoint past `local-gated`, or is terminal for a reason other than `PROVISIONER_REJECTED`
- **THEN** supersession refuses, because provider-side destruction may already have begun and the control plane cannot establish otherwise on its own

#### Scenario: Supersession eligibility differs

- **WHEN** the tenant is not deletion-pending, holds more than one live cell, has another unfinished operation, or no longer matches the caller-pinned fence
- **THEN** supersession refuses without changing tenant, cell, operation, assignment, audit, or capacity state

#### Scenario: Supersession is replayed

- **WHEN** the same authenticated request is retried after its transition committed
- **THEN** a separate replay branch requires the pinned operation to be `failed_terminal` with `DELETION_SUPERSEDED` and its derived-key replacement to exist
- **AND** it returns the same replacement operation without advancing the fence again or enqueueing another delete

### Requirement: A diverged cell's recorded runtime identity can be corrected under operator authority

An authenticated operator MAY move one caller-pinned cell's recorded release, observed gateway contract digest, observed command fingerprint, observed schema digest, and observed compatibility digest onto a cataloged contract candidate, and the service SHALL take that identity only from a terminal rollout assignment already minted for the same tenant on the same candidate, never composing any digest at the call site. The correction SHALL be atomic under the exclusive cohort lock, SHALL move the cell's routable contract observation with it, SHALL install exactly one active time-bounded assignment on that candidate, and SHALL persist a content-free principal-bound audit receipt naming the corrected release. It MUST fail closed for a tenant that is not reviewer-purpose, a tenant at a different fence than the caller pinned, a cell that is not the tenant's only live cell, a cell that is not bound or retiring, a cell missing any observed digest, a cell whose recorded release differs from the one the caller pinned, a candidate that is not cataloged or does not differ from what the cell records, an absent or still-live source assignment, any lifecycle operation in flight, or any preparing or active assignment. It MUST NOT call the provider, alter capacity, alter the tenant fence, or mark any operation complete.

#### Scenario: A diverged cell is corrected

- **WHEN** an authenticated operator pins a reviewer-purpose tenant's only live cell, its current fence, the release that cell records, and a cataloged candidate that differs from it and carries a terminal assignment for the same tenant
- **THEN** one atomic transaction moves the cell's recorded release and its four observed digests onto that assignment's identity, moves the routable observation to match, installs one active assignment bounded to thirty minutes, and writes a principal-bound audit receipt naming the corrected release
- **AND** the provider is not called and capacity is unchanged

#### Scenario: A corrected cell can mint an admissible operation

- **WHEN** a lifecycle operation is enqueued for that tenant after the correction commits
- **THEN** it derives its target from the installed active assignment rather than the cell's origin provision, and carries the corrected release, protocol version and gateway contract digest
- **AND** before the correction the same enqueue carries the stale identity that the deployment lock refuses

#### Scenario: Correction preflight is content free

- **WHEN** an authenticated operator preflights the same pinned cell, candidate, expected release and expected fence
- **THEN** the service evaluates the same eligibility boundary without mutation and returns only eligibility plus request metadata

#### Scenario: Correction eligibility differs

- **WHEN** the pinned tenant is not reviewer-purpose, the pinned fence is stale, the pinned current release does not match what the cell records, the candidate matches what the cell already records, the tenant has another live cell, an operation is in flight, or an assignment is preparing or active
- **THEN** correction refuses without changing cell, routable observation, assignment, audit, capacity, or operation state

#### Scenario: Correction is replayed

- **WHEN** the same authenticated correction request is retried after its transition committed
- **THEN** a separate replay branch requires the cell to already record that candidate's identity, one active unexpired assignment on it, and the prior audit receipt
- **AND** it returns the same assignment without installing another

