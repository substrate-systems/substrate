## ADDED Requirements

### Requirement: Friend price is one server-applied recurring Paddle discount

The friend price SHALL be one recurring Paddle discount for each environment, configured by its identifier. The server SHALL attach it to a checkout only for a tenant that accepted a friend offer. The server MUST ignore a discount sent by a client. Before each use the server SHALL verify that the discount is active, recurring without a limit on intervals, has no code, is not enabled for checkout, and is restricted to the Exomem price. If any check fails, friend checkout MUST fail closed. The discount identifier MUST NOT reach a browser.

#### Scenario: Invitee with a friend offer checks out

- **WHEN** a tenant that accepted a friend offer starts checkout
- **THEN** the transaction carries the configured discount

#### Scenario: Client sends a discount

- **WHEN** a checkout request carries a discount identifier or code
- **THEN** the server ignores it

#### Scenario: Discount is misconfigured

- **WHEN** the configured discount has a code or is enabled for checkout
- **THEN** friend checkout fails with a stable error and no transaction is created

#### Scenario: Price returns on resubscribe

- **WHEN** an owner with a recorded friend offer resubscribes after an ended subscription
- **THEN** the new transaction carries the friend discount

### Requirement: Subscription events store next payment, price name, discount and grace start

A verified `subscription.*` event, and reconciliation of a subscription, SHALL store the price identifier, the price name, the next billing time, the discount identifier and the scheduled change time. The system SHALL set the grace start to the first time of the current `past_due` period and clear it in every other state. Other event kinds MUST NOT write these fields. A re-admission SHALL reset them.

#### Scenario: Subscription event arrives

- **WHEN** a verified subscription event reports a price, a next billing time and a discount
- **THEN** the entitlement stores them

#### Scenario: Payment fails twice

- **WHEN** a second `past_due` event arrives in the same failed period
- **THEN** the grace start keeps its first value

#### Scenario: Payment recovers

- **WHEN** the subscription returns to active
- **THEN** the grace start is cleared

#### Scenario: Reconciliation observes the subscription

- **WHEN** reconciliation reads the subscription from Paddle
- **THEN** it stores the same fields, in the same way as a webhook

### Requirement: Self-serve and resubscribe checkouts use the server-selected catalog

Checkout SHALL accept a self-serve owner and an owner whose subscription ended inside the kept window. It SHALL return the transaction identifier that the Paddle overlay needs. For a resubscription it SHALL create a new transaction for the owner's existing Paddle customer. The server MUST still choose the product, price and discount. Checkout MUST refuse an owner who already has a live subscription.

#### Scenario: Self-serve owner starts checkout

- **WHEN** an owner admitted by email requests checkout
- **THEN** the response carries the hosted checkout URL and the transaction identifier

#### Scenario: Ended owner resubscribes inside the kept window

- **WHEN** an owner whose subscription ended starts checkout while their data is still kept
- **THEN** the server creates a new transaction for the same customer
- **AND** service resumes on the kept data when the new subscription becomes active

#### Scenario: Kept window has passed

- **WHEN** an ended owner starts checkout after the kept window
- **THEN** the server refuses with a stable error

#### Scenario: Owner already has a live subscription

- **WHEN** an owner with a live subscription requests checkout
- **THEN** the server refuses and creates no second subscription
