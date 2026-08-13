## MODIFIED Requirements

### Requirement: Exomem access is invite only during alpha

During the friends-only v1 alpha, the system SHALL allow only an authenticated operator to create an Exomem invite. Each operator-issued invite MUST be bound to one normalized email address, an entitlement source, an expiration, and a single high-entropy token whose digest rather than plaintext is stored. Anonymous visitors MAY submit interest through the public interest endpoint, but MUST NOT mint an invite, create an account or tenant, or reserve capacity. Public self-serve/v2 admission, public paid offers, and new Paddle checkout are deferred. The contradictory historical proposal is archived at `openspec/changes/archive/2026-08-13-open-exomem-hosted-self-serve/` and cannot apply its deltas.

#### Scenario: Operator creates a complimentary invite

- **WHEN** an operator with valid Exomem invite authority creates an unexpired complimentary invite for an email address
- **THEN** the system stores a single-use digest-bound invite and returns or delivers one redemption URL
- **AND** the plaintext token is not written to logs or retained in the database

#### Scenario: Anonymous visitor requests Hosted access while capacity is free

- **WHEN** an anonymous visitor calls the former public access-request endpoint
- **THEN** the endpoint fails closed without invoking self-serve admission
- **AND** no invite, capacity reservation, account, tenant, entitlement, or provisioning operation is created

#### Scenario: Public visitor expresses interest

- **WHEN** an anonymous visitor submits the public interest form
- **THEN** the system records or delivers only that interest signal
- **AND** the response does not promise or mint Hosted access

#### Scenario: Public caller attempts to create an invite

- **WHEN** a caller without operator authority invokes the invite creation boundary
- **THEN** the system rejects the request without revealing invite or account state

#### Scenario: Operator-issued paid invite has no new checkout action

- **WHEN** an operator-issued `source: paid` invite is redeemed during the friends-only alpha
- **THEN** the account surface does not advertise a new checkout action
- **AND** a request to start checkout fails before it can create a provider transaction
- **AND** existing subscription reconciliation, cancellation, and transaction-bound return handling remain available
