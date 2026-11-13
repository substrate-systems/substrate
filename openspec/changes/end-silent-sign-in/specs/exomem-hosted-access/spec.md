## MODIFIED Requirements

### Requirement: Existing users can request a non-enumerating sign-in link

An identity that already owns an active Exomem tenant SHALL be able to request a short-lived, single-use sign-in link by email. The public response MUST be indistinguishable for known and unknown addresses, and requesting a link MUST NOT create an account or tenant. Every request with a well-formed address that passes the bot check and the rate limits SHALL end with an outcome email to the submitted address that states what happens for that address. The request queues that email, except that a waiting or invited address that repeats a request inside the same fixed 15-minute window queues nothing new: the same outcome email queued earlier in that window stands, so the page's claim that an email was sent stays true. No accepted request SHALL end without an email. A request whose address cannot be used SHALL be refused with an `invalid_email` answer after the bot check, and the page SHALL ask the person to check the address instead of claiming that an email was sent.

#### Scenario: Existing Exomem owner requests a link

- **WHEN** an existing owner submits their normalized email within rate limits
- **THEN** the system sends a short-lived single-use sign-in link and returns the generic acknowledgement

#### Scenario: Unknown address requests a link

- **WHEN** an address with no Exomem tenant submits the same request
- **THEN** the system returns the same generic acknowledgement without creating identity, tenant or entitlement
- **AND** the email to that address says what happens next: a waitlist place, a start link, or a pending invitation

#### Scenario: Invited address without an account requests a link

- **WHEN** an address with a live, unused, non-self-serve invitation and no tenant submits the request
- **THEN** the system queues an invitation-waiting email that carries a fresh link to that invitation and names when the invitation expires
- **AND** the fresh link replaces every earlier link for the invitation, and the email says so
- **AND** the invitation's expiry, kind, entitlement and place in capacity do not change
- **AND** the system replaces the link at most once per fixed 15-minute window: a repeat inside the window queues nothing new and leaves the link of that window's email working
- **AND** only the newest link is ever emailed: an invitation email that was queued with an earlier link is cancelled
- **AND** while an email that carries the invitation's current link is being sent, the system queues nothing and leaves the link unchanged, so the email in flight is never left with a dead link
- **AND** the address does not join the waitlist

#### Scenario: Waiting person asks again

- **WHEN** a person who already waits submits the request again
- **THEN** their entry keeps its place and no second entry exists
- **AND** the system queues a still-waiting email, at most one per fixed 15-minute window per entry
- **AND** a repeat inside the same window queues nothing new, because the still-waiting email of that window already went out
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

### Requirement: A refused start request says that nothing was sent

When a rate limit refuses a start request, the system SHALL tell the browser which limit refused it (network, browser or address) and when to try again, and the page SHALL say that this request sent no email. The page MUST NOT say that the address was emailed, because every limit counts requests, not emails. The limits SHALL be taken before any branch that depends on account state, so the answer is the same for every address. A wait longer than one minute SHALL be shown as a duration in words, never as a clock reading; a resend button MAY count down a wait of one minute or less as minutes and seconds. The response status, body keys and time floor SHALL stay those of every other accepted request.

#### Scenario: Address asked too often

- **WHEN** a browser submits an address that has used its hourly request allowance
- **THEN** the page says that the address was asked for several times this hour, that no further email was sent, and when to try again
- **AND** an address with an account and one without get the same answer

#### Scenario: Another address asked within a minute

- **WHEN** a browser submits a second address within one minute of its first request
- **THEN** the system queues nothing for the second address and names the browser limit
- **AND** the page says that the request was too soon and that no email was sent, without saying that the address was emailed

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
- **AND** the failure is the same whether the provider accepts the canary email or not

#### Scenario: Webhook request is not from the provider

- **WHEN** the webhook receives a request with a missing or wrong bearer token, or the token is not configured
- **THEN** the system stores nothing and answers `401` or `503`

### Requirement: Sign-in delivery is proven continuously

The system SHALL prove, without a person, that a start request ends in a delivered email, and SHALL keep proving it. The email health proof SHALL start a sign-in for a configured canary address through the same server function that the start route calls, from the scheduler-authenticated health route only, and SHALL send the email it queues before the run ends. It MAY skip only the browser bot check. Each run SHALL judge the canary's newest email that is old enough for the delivery bound to have run out, which is normally the previous run's: the provider MUST have accepted it within a configured time after its due time (60 seconds by default), and MUST have reported it delivered within a configured time after accepting it (10 minutes by default). A run SHALL NOT fail for an email whose delivery bound has not run out. The proof SHALL take its result from the start request of its own run, never from the age of an earlier email: the start MUST queue a waitlist email that the provider accepts with a message id, or, when the current 15-minute window already queued its reply, that reply MUST be one that the provider accepted with a message id; a reply that is still pending or failed fails the run. The proof SHALL fail, with a distinct code each, when the canary address is unset or invalid, owns an account, holds an invitation, when the start fails or a rate limit refuses it, or when the provider does not accept the new canary. Every database transaction and statement that the proof makes SHALL end a lock wait and a statement at a limit of its own, without changing any other caller, and the proof SHALL stop its own work at a deadline inside the scheduler's timeout, wait for its open transaction to end, and still save a failed result. Each run SHALL record the measured queue and delivery times in a content-free operational event. The canary MUST NOT take a Cloud place, whoever starts it and in any admission mode, MUST NOT be promoted from the waitlist, MUST NOT count as a person waiting, and MUST NOT appear in the delivery report's per-kind numbers; the report SHALL show it in a section of its own, and SHALL say that no canary is sent when none is configured.

#### Scenario: Canary accepted and delivered

- **WHEN** the email health proof runs and the canary email being judged was accepted within its bound and reported delivered within its bound
- **THEN** the run starts a new canary through the start request, sends it before the run ends and the provider accepts it with a message id
- **AND** the proof passes
- **AND** the run records the queue time of the new canary and the delivery time of the one judged, and no address

#### Scenario: Canary not delivered within the bound

- **WHEN** the canary email being judged is older than the delivery bound and the provider reported no delivery within that bound
- **THEN** the proof fails, and the run still sends a new canary so that the proof can recover
- **AND** a stopped provider webhook fails the proof in the same way

#### Scenario: Canary accepted late

- **WHEN** the provider accepted the canary email being judged later than the queue bound after its due time
- **THEN** the proof fails

#### Scenario: First run and early run

- **WHEN** no canary email is older than the delivery bound, or the run repeats minutes after the last
- **THEN** the proof does not fail for the missing delivery, and passes if the new canary is accepted, or the start finds the window's email already accepted

#### Scenario: Canary start does not prove delivery

- **WHEN** the canary address owns an account, holds an invitation, or its start fails, within the window of an earlier passing run
- **THEN** the proof fails with the code for that cause, and does not pass on the earlier run's email

#### Scenario: Repeated start finds an email the provider has not accepted

- **WHEN** the provider rejects the canary's email, and the proof runs three times inside one 15-minute window
- **THEN** every run fails, including the runs whose start queues nothing new
- **AND** the proof passes once the provider has accepted the window's email

#### Scenario: Canary start stalls

- **WHEN** a database lock that the canary needs, such as the Cloud capacity lock or a lock on the tenants table, stays held
- **THEN** the canary's wait gives up at its lock limit, the proof fails with a timeout code, and no canary transaction is left open
- **AND** it saves its failed result inside the scheduler's timeout

#### Scenario: Canary never takes a place or distorts the report

- **WHEN** admission is `open` and Cloud has a free place, and the canary address starts, from the health proof or from the public start page
- **THEN** the canary takes a waitlist place only, and no start link, invitation, Cloud place or admission pace
- **AND** waitlist promotion skips the canary's entry, and it does not count as a person waiting, so a newcomer is still admitted at once
- **AND** the delivery report's per-kind counts and latencies leave out the canary's emails and report them in a canary section with the last runs, their queue and delivery times and their outcome

### Requirement: A failed bot check says that no email was sent

When the bot check fails, or its widget cannot produce a token, the start page SHALL say that the browser could not be confirmed as a person, that no email was sent, and what to do.

#### Scenario: Bot check fails

- **WHEN** the bot check fails on a start request
- **THEN** the page says that it could not confirm that the browser is a person and did not send an email
- **AND** it suggests trying again, or another browser if it keeps failing
