## ADDED Requirements

### Requirement: The private operator console uses product-scoped authentication

The system SHALL expose an Exomem operator console outside public navigation and
search indexing. It MUST exchange the existing operator bearer through a
rate-limited, same-origin, no-store request for a purpose-bound, eight-hour Secure,
HttpOnly, SameSite session that contains neither the bearer nor email. Every
operator mutation MUST validate same-origin context and session-bound CSRF.

#### Scenario: Operator establishes a browser session

- **WHEN** an operator submits the valid Exomem operator bearer from the same-origin console
- **THEN** the system returns an opaque product-scoped operator session and session-bound CSRF value
- **AND** neither the bearer nor operator email appears in the cookie, response body, browser storage, analytics, or logs

#### Scenario: Unauthorized caller opens the console

- **WHEN** a caller has no valid operator session
- **THEN** the system reveals no invitation or tenant data and presents only the operator sign-in boundary

#### Scenario: Cross-site caller attempts an operator mutation

- **WHEN** a valid operator cookie accompanies a mutation with a missing or conflicting origin or CSRF value
- **THEN** the system rejects the mutation before reading or changing invitation, capacity, tenant, or billing state

### Requirement: The console issues capacity-safe private-alpha invitations

The operator console SHALL show hard reservations and unexpired deliverable paid
invitations against the configured private-alpha capacity. New invitations MUST be
paid by default, MUST use the server-selected private_alpha_monthly plan key, and
MUST require a separate explicit action for complimentary access. Paid invite
issuance MUST serialize on the capacity pool and refuse a soft commitment when no
slot remains.

#### Scenario: Operator issues a paid invitation

- **WHEN** an authenticated operator submits one normalized email while private-alpha checkout is enabled and capacity remains
- **THEN** the system creates and delivers one expiring single-use invitation for the private_alpha_monthly plan
- **AND** the response shows the updated hard-reservation and soft-commitment counts without exposing a plaintext invite token

#### Scenario: Operator explicitly issues a complimentary invitation

- **WHEN** an authenticated operator deliberately selects complimentary access and confirms the invitation
- **THEN** the system creates a complimentary invitation through the existing entitlement path
- **AND** paid remains the default for the next invitation

#### Scenario: Concurrent operators contend for the last slot

- **WHEN** two paid invitation requests concurrently target the final available private-alpha slot
- **THEN** exactly one request creates a deliverable invitation and the other receives a stable capacity-full response

#### Scenario: Public caller searches for the console

- **WHEN** a crawler or ordinary visitor follows public navigation or reads the sitemap
- **THEN** the operator console is absent and its responses prohibit indexing and caching
