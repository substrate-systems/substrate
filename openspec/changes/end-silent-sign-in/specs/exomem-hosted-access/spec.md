## MODIFIED Requirements

### Requirement: Existing users can request a non-enumerating sign-in link

An identity that already owns an active Exomem tenant SHALL be able to request a short-lived, single-use sign-in link by email. The public response MUST be indistinguishable for known and unknown addresses, and requesting a link MUST NOT create an account or tenant. Every request with a well-formed address that passes the bot check and the rate limits SHALL queue exactly one email to the submitted address that states what happens for that address. No accepted request SHALL end without an email. A request whose address cannot be used SHALL be refused with an `invalid_email` answer after the bot check, and the page SHALL ask the person to check the address instead of claiming that an email was sent.

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

#### Scenario: Address the server cannot use

- **WHEN** an address passes the browser's email check but is not shaped like an email address on the server, such as a host without a dot
- **THEN** the system answers `400` with `invalid_email` after the bot check and queues nothing
- **AND** the page asks the person to check the address and does not say that an email was sent
- **AND** the answer depends on the address's shape only, so it reveals nothing about any account

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

### Requirement: Email delivery is observable

The system SHALL let an operator see, for each kind of Exomem email, whether it was sent, failed or cancelled, how long it waited, and what the mail provider reported after it accepted the email. The system SHALL store the provider's message id on the outbox row when the provider accepts a send, and SHALL receive the provider's transactional events through an authenticated webhook that stores only the message id, the event name and its time. The delivery report SHALL name its window and sources and SHALL state that delivery is unknown, not zero, when the provider has reported no event. The email health proof SHALL fail when a queued email is ready but unsent for longer than a configured time, or when an email failed for a reason other than refusal within the last hour.

#### Scenario: Provider event is matched to its email

- **WHEN** the provider accepts an email and later posts a `delivered` event for its message id
- **THEN** the system stores the event once, however often the provider repeats it
- **AND** the delivery report shows the time from acceptance to delivery for that email's kind
- **AND** no address, subject, reason text or IP is stored with the event

#### Scenario: No provider event has been received

- **WHEN** an operator reads the delivery report and the provider has never posted an event
- **THEN** the report gives queue and acceptance figures from the outbox
- **AND** its delivery fields are `null` with `deliveryEvidence` set to `none_received`, not zero

#### Scenario: Delivery stalls

- **WHEN** an email has been ready but unsent for longer than the configured time
- **THEN** the email health proof fails and the existing email health monitor alerts
- **AND** the failure is the same whether the provider accepts the synthetic send or not

#### Scenario: Webhook request is not from the provider

- **WHEN** the webhook receives a request with a missing or wrong bearer token, or the token is not configured
- **THEN** the system stores nothing and answers `401` or `503`
