## MODIFIED Requirements

### Requirement: Exomem access is invite only during alpha

The system SHALL allow only an authenticated operator to create an Exomem alpha
invite. Each invite MUST be bound to one normalized email address, an entitlement
source, an expiration, a single high-entropy token whose digest rather than plaintext
is stored, and either complimentary or paid Paddle access. Paid operator invite
issuance MUST reuse the alpha pool's serialized capacity decision across both hard
reservations and unexpired, unrevoked, delivered paid operator invitations. The
public self-serve admission endpoint MUST remain unavailable.

#### Scenario: Operator creates a complimentary invite

- **WHEN** an operator with valid Exomem invite authority creates an unexpired complimentary invite for an email address
- **THEN** the system stores a single-use digest-bound invite and returns or delivers one redemption URL
- **AND** the plaintext token is not written to logs or retained in the database

#### Scenario: Operator creates a paid private-alpha invite

- **WHEN** an authorized operator creates a paid invitation while one private-alpha slot remains
- **THEN** the system stores and delivers one operator-authorized Paddle invite and counts it as a soft capacity commitment
- **AND** the browser cannot substitute the Paddle product, price, environment, or public admission path

#### Scenario: Invitation delivery fails or expires

- **WHEN** a paid invite is not successfully delivered, expires, or is revoked before redemption
- **THEN** it no longer consumes a soft capacity commitment
- **AND** its historical record remains available for audit

#### Scenario: Public caller attempts to create an invite

- **WHEN** a caller without operator authority invokes the invite creation boundary
- **THEN** the system rejects the request without revealing invite, capacity, or account state

### Requirement: Invite redemption is email bound, atomic, and idempotent

Redeeming a valid invite SHALL atomically consume that invite, resolve or create the
shared identity for its bound email, resolve or create exactly one Exomem tenant
owned by that identity, project the invite entitlement, reserve one hard capacity
allocation, and create an Exomem product session. Complimentary redemption SHALL
enqueue its initial provisioning operation through the existing path. Paid
Paddle redemption SHALL leave its allocation reserved without an operation
and SHALL NOT create or contact a cell, volume, provider claim, or provisioner until
verified payment activation. The caller MUST NOT replace the bound email or choose a
tenant, plan, catalog item, or provider environment during redemption.

#### Scenario: New complimentary invitee redeems a valid invite

- **WHEN** a user accepts the displayed bound email and redeems a valid unused complimentary invite before expiry
- **THEN** the system creates or resolves one identity, one Exomem tenant, one entitlement, one capacity allocation, one initial provisioning operation, and one product session
- **AND** repeated delivery or database retry converges without creating a second tenant or operation

#### Scenario: New paid invitee redeems a valid invite

- **WHEN** a user accepts the displayed bound email and redeems a valid unused paid operator invite before expiry
- **THEN** the system atomically creates or resolves one identity, tenant, awaiting-checkout entitlement, reserved allocation, and product session
- **AND** it creates no lifecycle operation or provider resource before verified payment activation

#### Scenario: Hard capacity changed before redemption

- **WHEN** a paid invitation is redeemed but no hard capacity slot can be reserved
- **THEN** redemption fails with a stable capacity response and leaves the invitation unconsumed
- **AND** no partial identity, tenant, entitlement, session, allocation, or lifecycle operation is committed

#### Scenario: Consumed or expired invite is replayed

- **WHEN** a consumed, revoked, malformed, or expired invite token is presented
- **THEN** redemption fails with a stable non-enumerating error
- **AND** no session, tenant, entitlement, allocation, or provisioning operation is created

#### Scenario: Caller attempts to replace the invite email

- **WHEN** a redemption request includes an email different from the invite's bound email
- **THEN** the supplied email is ignored or rejected
- **AND** no identity or tenant is created for the supplied address
