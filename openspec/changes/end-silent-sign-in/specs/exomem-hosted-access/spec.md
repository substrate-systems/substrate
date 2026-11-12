## MODIFIED Requirements

### Requirement: Existing users can request a non-enumerating sign-in link

An identity that already owns an active Exomem tenant SHALL be able to request a short-lived, single-use sign-in link by email. The public response MUST be indistinguishable for known and unknown addresses, and requesting a link MUST NOT create an account or tenant. Every request that passes the bot check and the rate limits SHALL queue exactly one email to the submitted address that states what happens for that address. No accepted request SHALL end without an email.

#### Scenario: Existing Exomem owner requests a link

- **WHEN** an existing owner submits their normalized email within rate limits
- **THEN** the system sends a short-lived single-use sign-in link and returns the generic acknowledgement

#### Scenario: Unknown address requests a link

- **WHEN** an address with no Exomem tenant submits the same request
- **THEN** the system returns the same generic acknowledgement without creating identity, tenant or entitlement
- **AND** the email to that address says what happens next: a waitlist place, a start link, or a pending invitation

#### Scenario: Invited address without an account requests a link

- **WHEN** an address with a live, unused, non-self-serve invitation and no tenant submits the request
- **THEN** the system queues an invitation-waiting email that names when the invitation was sent and when it expires
- **AND** the email carries no new token, and the invitation link already delivered stays valid
- **AND** the address does not join the waitlist

#### Scenario: Waiting person asks again

- **WHEN** a person who already waits submits the request again
- **THEN** their entry keeps its place and no second entry exists
- **AND** the system queues a still-waiting email, at most one per 15 minutes per entry
- **AND** the email reveals no queue position

## ADDED Requirements

### Requirement: Start emails dispatch when the request commits

The system SHALL dispatch each email that a start request queues as soon as the transaction that queued it commits, under the same lease, precondition re-check and retry rules as the delivery job. The delivery job SHALL remain the fallback for a dispatch that fails or never runs. One outbox row MUST NOT be sent twice by the immediate dispatch and the job together while its lease holds.

#### Scenario: Waitlist email is sent at once

- **WHEN** a new address joins the waitlist
- **THEN** the request's own dispatch sends the waitlist email without waiting for the next delivery job run

#### Scenario: Immediate dispatch fails

- **WHEN** the provider is unavailable during the immediate dispatch
- **THEN** the row stays queued with its retry time, and the delivery job sends it later

### Requirement: The per-address request limit is visible

When a request exceeds the per-address limit, the system SHALL tell the browser that the request was limited and when to try again. The limit SHALL be taken before any branch that depends on account state, so the answer is the same for every address. The response status, body shape and time floor SHALL stay those of every other accepted request.

#### Scenario: Address asked too often

- **WHEN** a browser submits an address that has used its hourly request allowance
- **THEN** the page says that the address was emailed several times this hour and names when to try again
- **AND** an address with an account and one without get the same answer
