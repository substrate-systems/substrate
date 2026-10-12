## MODIFIED Requirements

### Requirement: Normal Exomem operations do not call Paddle

Capture, recall, browse, upload, download, readiness, export polling, and Home rendering MUST read internal entitlement state only. Paddle calls SHALL be confined to checkout, customer-portal, explicit reconciliation, and webhook-adapter workflows, plus three invitation workflows: the invitation price preview, the friend-price subscription update, and the friend-discount verification.

#### Scenario: Paddle API is unavailable during recall

- **WHEN** an active tenant recalls memory while Paddle is unavailable
- **THEN** recall proceeds using the last authoritative internal entitlement without contacting Paddle

#### Scenario: Paddle API is unavailable while Home renders

- **WHEN** an owner opens Home while Paddle is unavailable
- **THEN** Home renders from stored entitlement data without contacting Paddle

#### Scenario: Invitation page needs a price

- **WHEN** an invitee inspects a friend invitation
- **THEN** the system may call the Paddle price preview for that request
- **AND** a failed preview shows the price as unknown and blocks nothing else

## ADDED Requirements

### Requirement: Friend price is one server-applied recurring Paddle discount

The friend price SHALL be one recurring Paddle discount for each environment, configured by its identifier. The server SHALL attach it to a checkout only for a tenant that accepted a friend offer. The server MUST ignore a discount that a client sends. The discount identifier MUST NOT reach a browser.

#### Scenario: Invitee with a friend offer checks out

- **WHEN** a tenant that accepted a friend offer starts checkout
- **THEN** the transaction carries the configured discount

#### Scenario: Client sends a discount

- **WHEN** a checkout request carries a discount identifier or code
- **THEN** the server refuses the request and creates no transaction

#### Scenario: Price returns on resubscribe

- **WHEN** an owner with a recorded friend offer resubscribes after an ended subscription
- **THEN** the new transaction carries the friend discount

### Requirement: Friend discount is verified before every use and fails closed

Before it attaches the friend discount to a checkout, or applies it to a subscription, the server SHALL verify that the discount is active, recurring without a limit on intervals, has no code, is not enabled for checkout, and is restricted to the Exomem price. If any check fails, the server MUST refuse the action and make no change at the provider.

#### Scenario: Discount has a code at checkout

- **WHEN** the configured discount has a code or is enabled for checkout and a friend checkout starts
- **THEN** the server fails with a stable error and creates no transaction

#### Scenario: Discount fails at a subscription update

- **WHEN** the same check fails when an owner chooses the friend price on a live subscription
- **THEN** the server refuses with a stable error and leaves the subscription unchanged

### Requirement: Subscription events store next payment, price name and discount

A verified `subscription.*` event, and reconciliation of a subscription, SHALL store the price identifier, the price name, the next billing time, the discount identifier and the scheduled change time. Other event kinds MUST NOT write these fields. A re-admission SHALL reset them.

#### Scenario: Subscription event arrives

- **WHEN** a verified subscription event reports a price, a next billing time and a discount
- **THEN** the entitlement stores them

#### Scenario: Reconciliation observes the subscription

- **WHEN** reconciliation reads the subscription from Paddle
- **THEN** it stores the same fields, in the same way as a webhook

### Requirement: The grace start marks a move into past due

The system SHALL set the grace start to the event time only when the state moves into `past_due`. While the state stays `past_due`, it SHALL keep the stored value, and an unknown value SHALL stay unknown. It SHALL clear the value when the state leaves `past_due`. It MUST NOT guess a date from an update time.

#### Scenario: Payment fails twice

- **WHEN** the state moves into `past_due` and a second `past_due` event follows in the same failed period
- **THEN** the grace start keeps the time of the move

#### Scenario: Grace start is unknown

- **WHEN** a `past_due` event arrives for an entitlement that was already `past_due` and has no stored grace start
- **THEN** the grace start stays unknown

#### Scenario: Payment recovers

- **WHEN** the subscription returns to active
- **THEN** the grace start is cleared

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
