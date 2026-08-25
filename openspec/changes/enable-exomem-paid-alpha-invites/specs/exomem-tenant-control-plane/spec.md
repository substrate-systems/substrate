## MODIFIED Requirements

### Requirement: Provisioning converges through durable desired state

Creating a complimentary tenant SHALL enqueue an idempotent lifecycle operation
that converges one isolated cell with distinct vault, state, and log roots. Creating
a paid private-alpha tenant SHALL instead reserve capacity with no initial operation
until authoritative active or trialing payment activation atomically creates and
attaches that operation. No paid redemption, awaiting-payment Home request, or
checkout creation MAY contact the provisioner or create a cell, volume, or provider
claim. The web request MUST NOT report a ready service until private readiness
confirms the expected cell identity, protocol, release, mutation authority, and
worker policy.

#### Scenario: Complimentary redemption queues provisioning immediately

- **WHEN** a valid complimentary invitation creates a tenant
- **THEN** the transaction reserves capacity and enqueues one initial provisioning operation through the existing lifecycle path

#### Scenario: Paid redemption waits for payment

- **WHEN** a valid private_alpha_monthly invitation creates an awaiting-payment tenant
- **THEN** the tenant holds one reserved allocation with no operation identifier
- **AND** no provider-facing work is runnable

#### Scenario: Awaiting-payment owner starts checkout

- **WHEN** the owner creates or resumes its bound Paddle checkout
- **THEN** the allocation remains reserved without an operation and the provisioner is not contacted

#### Scenario: Verified activation releases provisioning

- **WHEN** the first authoritative active or trialing subscription revision is committed for the reserved tenant
- **THEN** exactly one pinned initial provisioning operation is created and attached to the allocation in that transaction

#### Scenario: Provisioning succeeds after retries

- **WHEN** repeated reconciler runs process the same tenant provisioning operation
- **THEN** provider calls use the same idempotency identity, one logical cell is created, and the operation advances through durable checkpoints to succeeded

#### Scenario: Provider acknowledgement is lost

- **WHEN** the provisioner creates a resource but the control-plane request times out before recording success
- **THEN** reconciliation queries or repeats the same idempotent operation and adopts the existing matching resource
- **AND** it does not create a second active cell

#### Scenario: Cell reports another identity

- **WHEN** a provisioned endpoint's private readiness response names a different cell or incompatible protocol
- **THEN** the operation fails closed and the endpoint is never bound for public routing
