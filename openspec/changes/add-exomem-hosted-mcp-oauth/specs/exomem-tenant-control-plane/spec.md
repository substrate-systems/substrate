## ADDED Requirements

### Requirement: Capacity Admission Precedes First-Login Provisioning

The control plane SHALL maintain a durable capacity ledger that distinguishes retained storage occupancy, active runtime slots, and in-flight provisioning slots. Before a first eligible OAuth authorization can consume its invite, create a tenant/entitlement/grant, or enqueue provider work, one database transaction MUST reserve the configured tenant storage allowance, one runtime slot, and one provisioning slot or fail without those state changes. Reservation, tenant, and initial-provision identities MUST be unique and replay-safe for the authoritative identity/invite admission.

#### Scenario: First authorization has available capacity

- **WHEN** an eligible new identity authorizes and every required capacity dimension is available
- **THEN** one transaction reserves the alpha allocation and creates or resolves exactly one tenant, entitlement, OAuth grant, and `initial-provision` operation
- **AND** later provider calls use that operation's stable idempotency identity

#### Scenario: Concurrent callbacks race first admission

- **WHEN** duplicate OAuth callbacks or concurrent valid authorizations race for the same identity and invite
- **THEN** database constraints and transaction isolation converge on one capacity reservation, tenant, entitlement, logical provision operation, cell, and volume
- **AND** replays return the existing admission result or a stable conflict without consuming more capacity

#### Scenario: Required capacity is unavailable

- **WHEN** storage, runtime, or provisioning capacity cannot be reserved
- **THEN** the admission fails before invite consumption, tenant/entitlement/grant/operation creation, or any provider call
- **AND** the valid invite remains eligible for a later bounded retry

#### Scenario: Existing tenant authorizes another client

- **WHEN** another supported client authorizes for an identity with one existing eligible tenant
- **THEN** it attaches to the tenant's existing occupancy and active runtime state
- **AND** it creates no new tenant reservation, provision operation, cell, or volume

### Requirement: Capacity Follows Verified External Lifecycle

Reserved capacity SHALL advance to occupied capacity only with the matching verified external resources. Provision failure, suspension, resume, and deletion MUST update capacity only after the reconciler proves the corresponding provider state, and uncertain acknowledgements MUST retain conservative capacity until reconciled. Provision claims SHALL be globally bounded so concurrent admissions cannot exceed the configured in-flight provider-work limit.

#### Scenario: Provider acknowledgement is lost during provisioning

- **WHEN** a provider may have created the cell or volume but acknowledgement is lost
- **THEN** the reservation remains held while reconciliation queries or repeats the same idempotent operation
- **AND** capacity is neither double-counted nor released for another tenant until exact state is proven

#### Scenario: Provisioning fails before any resource exists

- **WHEN** a terminal failure proves that no cell, volume, or other reserved resource was created
- **THEN** the reconciler releases the matching storage, runtime, and provisioning reservation through one fenced transition
- **AND** it does not delete or release another tenant's occupancy

#### Scenario: Provision concurrency limit is reached

- **WHEN** more runnable initial operations exist than the configured global provision concurrency
- **THEN** only the bounded number hold active provision claims and call the provider
- **AND** remaining operations stay durably queued without changing their idempotency identity

#### Scenario: Deletion is not externally complete

- **WHEN** a tenant is deletion-pending but volume or compute destruction is unverified
- **THEN** the corresponding capacity remains occupied
- **AND** admission cannot overcommit it to a new tenant

### Requirement: Suspension Releases Runtime But Preserves Retained Storage

Suspending an Exomem tenant SHALL deny routing and enqueue an idempotent lifecycle transition that stops or quiesces its active process. The runtime slot MUST be released only after the provider confirms inactivity, while the volume and configured storage allowance remain occupied for the retention period. Resuming MUST reacquire runtime capacity before starting the same mapped cell and MUST fail or wait without selecting another tenant when capacity is unavailable.

#### Scenario: Active tenant is suspended

- **WHEN** entitlement or operator policy suspends a ready tenant
- **THEN** routing stops immediately and reconciliation verifies its process is inactive before releasing the runtime slot
- **AND** the tenant's volume, mapping, and storage occupancy remain retained and inaccessible to other tenants

#### Scenario: Suspended tenant resumes with capacity

- **WHEN** policy permits resume and a runtime slot can be atomically acquired
- **THEN** reconciliation starts the same authoritative cell, verifies readiness, and restores routing
- **AND** no new volume, tenant, or cell identity is created

#### Scenario: Suspended tenant resumes without capacity

- **WHEN** policy permits resume but no runtime slot is available
- **THEN** the tenant remains safely suspended or resume-pending with a stable capacity outcome
- **AND** its retained data is not routed through another cell or destroyed
