## MODIFIED Requirements

### Requirement: Anonymous first-subscription events bootstrap onboarding

`POST /api/webhooks/paddle` MUST resolve an anonymous buyer by Paddle customer
email when the first usable lifecycle event is either `subscription.created` or
`subscription.activated` and no `custom_data.user_id`, legacy passthrough, or
existing customer mapping resolves the user.

The handler MUST create or reuse the email-addressed pre-account, upsert the
subscription, create an event-keyed claim token for a user without credentials,
and attempt the claim email before declaring the event processed.

#### Scenario: Real-shaped anonymous subscription.activated bootstraps a pre-account

- **GIVEN** a `subscription.activated` payload with a subscription id,
  customer id, recurring Hosted Backup price, and `custom_data = null`
- **AND** no user is mapped to the Paddle customer
- **WHEN** Paddle customer lookup returns the buyer email
- **THEN** the webhook creates or reuses exactly one pre-account
- **AND** upserts the active subscription
- **AND** creates exactly one claim-token row for the Paddle event
- **AND** attempts the claim email

#### Scenario: Anonymous subscription.created remains supported

- **WHEN** the equivalent first event is `subscription.created`
- **THEN** it follows the same pre-account and claim-email path

#### Scenario: Created and activated do not duplicate onboarding

- **GIVEN** Paddle emits both `subscription.created` and
  `subscription.activated` for one subscription
- **WHEN** both events reach the Hosted Backup destination
- **THEN** the subscription-level delivery state permits exactly one initial
  claim or FYI email
- **AND** a later recovery `subscription.activated` does not restart onboarding

#### Scenario: Authenticated checkout keeps its current path

- **GIVEN** a subscription event with `custom_data.user_id`
- **WHEN** the webhook processes it
- **THEN** it correlates directly to that user without creating a pre-account or
  claim token

#### Scenario: Supporter transaction stays out of Hosted Backup onboarding

- **GIVEN** a `transaction.completed` event for the recognition-only Supporter
  product
- **WHEN** it is delivered to the Supporter/license destination
- **THEN** it is not processed by the Hosted Backup onboarding state machine

### Requirement: Webhook processing is retry-safe through required delivery

Event-level idempotency MUST distinguish a fully processed event from an event
whose processing failed or is still leased. Only a fully processed event may
return a successful deduplication response.

The event MUST NOT be marked processed until the subscription mutation and any
required initial claim/FYI email have succeeded. Customer lookup failures,
unresolved anonymous buyers, and Brevo failures MUST return a retryable non-2xx
response with a stable stage/error code and safe event identifiers in logs.

#### Scenario: Successful duplicate delivery is deduplicated

- **GIVEN** an event whose required effects and email delivery completed
- **WHEN** the same `event_id` is delivered again
- **THEN** the response is 200 deduped
- **AND** no user, subscription, claim token, or email is duplicated

#### Scenario: Failed first email attempt is retried

- **GIVEN** an anonymous first-subscription event whose pre-account,
  subscription, and claim row were created
- **AND** Brevo rejects the first send attempt
- **WHEN** the handler returns a retryable non-2xx and Paddle redelivers the
  same `event_id`
- **THEN** processing is reacquired
- **AND** the existing user and subscription are reused
- **AND** the unsent event-keyed claim row is replaced rather than duplicated
- **AND** a successful second send marks the claim delivery and event processed

#### Scenario: Partial processing is not misreported as deduped

- **GIVEN** an event receipt exists with `processed_at = null`
- **WHEN** the prior attempt has released or exceeded its processing lease
- **THEN** the same event can be processed again
- **AND** it is not returned as a successful duplicate

#### Scenario: Stale event worker is fenced

- **GIVEN** a stale worker resumes after a newer processing attempt acquired the
  same event
- **WHEN** the stale worker tries to release or complete the event
- **THEN** its older attempt number does not mutate the newer lease

### Requirement: Subscription events are product-classified

The Hosted Backup state machine MUST accept subscription lifecycle events only
when at least one event item matches a configured Hosted Backup price ID. Other
subscription products MUST return a successful ignored response without
creating Hosted Backup users, subscriptions, claims, or email deliveries.

#### Scenario: Another Paddle subscription product is ignored

- **GIVEN** a subscription lifecycle event whose item price is not a configured
  Hosted Backup price
- **WHEN** it reaches the account-wide destination
- **THEN** the event is ignored without entering Hosted Backup onboarding

### Requirement: Dedicated Hosted Backup notification destination

Production MUST have an active Paddle URL destination for
`https://substratesystems.io/api/webhooks/paddle` using its own endpoint secret.
It MUST subscribe to the Hosted Backup subscription lifecycle needed by the
state machine, including `subscription.created`, `subscription.activated`,
`subscription.updated`, `subscription.past_due`, `subscription.paused`,
`subscription.resumed`, and `subscription.canceled`.

The existing `/api/license/webhook` destination MUST remain responsible for
`transaction.completed` Supporter handling. The retired lifetime-license SKU
MUST NOT be handled there.

#### Scenario: Subscription activation reaches Hosted Backup webhook

- **WHEN** Paddle emits `subscription.activated` for a production Hosted Backup
  purchase
- **THEN** Paddle delivers it to `/api/webhooks/paddle`
- **AND** signature verification uses the dedicated Hosted Backup endpoint
  secret
