## ADDED Requirements

### Requirement: The private operator page reuses existing bearer APIs

The system SHALL expose an Exomem operator page outside public navigation and search
indexing. It SHALL use the existing bearer-authenticated capacity and invitation
APIs rather than introduce another operator authentication boundary. The page MUST
retain the supplied bearer only in page memory and MUST NOT place it in cookies,
browser storage, URLs, analytics, responses, or logs.

#### Scenario: Operator authenticates the page

- **WHEN** the operator supplies the valid existing Exomem admin bearer
- **THEN** the page reads coarse capacity through the existing operator API and enables invitation controls
- **AND** refreshing or closing the page discards the bearer and requires it again

#### Scenario: Unauthorized caller opens the page

- **WHEN** a caller has not supplied a valid operator bearer
- **THEN** the page reveals no capacity, invitation, tenant, or billing data
- **AND** the operator APIs retain their existing rate limits and non-enumerating failures

#### Scenario: Public caller searches for the page

- **WHEN** a crawler or ordinary visitor follows public navigation or reads the sitemap
- **THEN** the operator page is absent and its responses prohibit indexing and caching

### Requirement: The page issues capacity-safe alpha invitations

The operator page SHALL show coarse hard reservations and outstanding pending or
delivered paid operator invitations against configured alpha capacity. Invitations MUST default to
the existing paid Paddle source and MUST require a separate explicit action for
complimentary access. Paid issuance MUST serialize on the existing capacity pool and
refuse another soft promise when no slot remains.

#### Scenario: Operator issues a paid invitation

- **WHEN** an authenticated operator submits one normalized email while capacity remains
- **THEN** the existing invitation API creates and delivers one expiring paid invitation
- **AND** the page shows success and refreshed capacity without exposing the plaintext invite token

#### Scenario: Operator explicitly issues a complimentary invitation

- **WHEN** an authenticated operator deliberately selects complimentary access and confirms the invitation
- **THEN** the existing invitation API creates a complimentary invitation through its current path
- **AND** paid remains the default for the next invitation

#### Scenario: Paid invitations contend for the last slot

- **WHEN** two paid invitation requests concurrently target the final available alpha slot
- **THEN** exactly one request creates a deliverable invitation and the other receives a stable capacity-full response
