## Purpose

Define the private operator page that issues Exomem invitations, how it keeps the admin bearer, and which capacity it shows.

## ADDED Requirements

### Requirement: The private operator page keeps the admin bearer in memory

The operator page SHALL stay outside public navigation and search indexing. It SHALL use the existing bearer-authenticated invitation and capacity routes. The page MUST keep the supplied bearer in page memory only, and MUST NOT put it in cookies, browser storage, URLs, analytics or logs.

#### Scenario: Operator signs in to the page

- **WHEN** the operator supplies the valid admin bearer
- **THEN** the page enables its invitation controls
- **AND** a page refresh discards the bearer and asks for it again

#### Scenario: Unauthorized caller opens the page

- **WHEN** a caller has not supplied a valid admin bearer
- **THEN** the page shows no capacity, invitation, tenant or billing data

### Requirement: The operator page issues invitations by kind against Cloud capacity

The operator page SHALL default a new invitation to the paid standard kind. Covered (complimentary) access SHALL need a separate explicit confirmation, and the default SHALL return to paid after each send. The page SHALL offer friend invitations with an inviter name, a note and an inviter email. The page SHALL show free Cloud capacity, not the retired Hosted pool, and SHALL block an invitation of any kind when no place is free.

#### Scenario: Operator sends a paid invitation

- **WHEN** an authenticated operator submits one email while Cloud has a free place
- **THEN** the system creates and delivers one expiring paid invitation
- **AND** the page shows the refreshed free capacity and never the plaintext token

#### Scenario: Operator sends a covered invitation

- **WHEN** the operator selects covered access and confirms it
- **THEN** the system creates a complimentary invitation
- **AND** the next invitation defaults to paid again

#### Scenario: Operator sends a friend invitation

- **WHEN** the operator enters an inviter name and a note and sends a friend invitation
- **THEN** the invitation carries both, and the inviter email is optional

#### Scenario: Cloud is full

- **WHEN** no Cloud place is free
- **THEN** the page blocks every invitation kind and says that capacity is full
