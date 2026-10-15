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

### Requirement: Checkout prefills the authenticated owner's email

The setup, consent and Home checkout paths SHALL pass the known account email to Paddle's transaction checkout. The server-selected transaction, price, discount and custom data MUST remain authoritative. A caller without an email SHALL omit the customer prefill and keep checkout available. Home SHALL validate a returned transaction immediately and remove its URL credential. If the account read remains pending after two seconds, checkout SHALL open without prefill.

#### Scenario: Owner starts or resumes checkout

- **WHEN** an authenticated owner opens a server-created transaction from setup, consent or Home
- **THEN** Paddle receives the known account email for prefill without replacing the transaction's billing data

#### Scenario: Account email is unknown

- **WHEN** a checkout caller has no account email
- **THEN** checkout opens without a customer prefill

#### Scenario: Home account read hangs

- **WHEN** a returned transaction is valid but the optional account email read remains pending
- **THEN** Home validates the transaction and removes the URL credential immediately
- **AND** checkout opens without prefill after the bounded wait

### Requirement: Friend price uses the server-selected Paddle catalogue

The friend price SHALL use a dedicated monthly Paddle price for each environment, configured by its identifier. Paddle SHALL supply localized amounts and tax. The server SHALL select that price without a discount only for a tenant that accepted a friend offer. Until an environment configures that price, its existing verified recurring discount SHALL remain the fallback. Existing subscriptions with that discount SHALL remain recognized without migration. The server MUST refuse client-selected prices or discounts. Discount identifiers MUST NOT reach a browser.

#### Scenario: Invitee with a friend offer checks out

- **WHEN** a tenant that accepted a friend offer starts checkout
- **THEN** the transaction carries the configured friend price without a discount, or the verified legacy discount while no friend price is configured

#### Scenario: Client sends a discount

- **WHEN** a checkout request carries a discount identifier or code
- **THEN** the server refuses the request and creates no transaction

#### Scenario: Price returns on resubscribe

- **WHEN** an owner with a recorded friend offer resubscribes after an ended subscription
- **THEN** the new transaction uses the same server selection rule for friend pricing

### Requirement: Legacy friend discount is verified before every use and fails closed

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

Checkout SHALL accept a self-serve owner and an owner whose subscription ended inside the kept window. It SHALL return the transaction identifier that the Paddle overlay needs. For a resubscription it SHALL create a new transaction for the owner's existing Paddle customer. The server MUST still choose the product, price and discount. Checkout MUST refuse an owner who already has a live subscription, and an owner who confirmed the account's deletion. Checkout SHALL reopen an open transaction only when its actual price and discount match the server selection and the account may still buy. The server SHALL verify a legacy discount again before reuse. A replaced catalogue selection SHALL cancel the obsolete open transaction before creating another. Exact completed or canceled transaction recovery MUST remain independent of the current sale catalogue.

#### Scenario: Self-serve owner starts checkout

- **WHEN** an owner admitted by email requests checkout
- **THEN** the response carries the hosted checkout URL and the transaction identifier

#### Scenario: Ended owner resubscribes inside the kept window

- **WHEN** an owner whose subscription ended starts checkout while their data is still kept
- **THEN** the server creates a new transaction for the same customer
- **AND** service resumes on the kept data when the new subscription becomes active

#### Scenario: Kept window ends with an open resubscribe checkout

- **WHEN** an ended owner's kept window ends while a checkout they opened to resubscribe is still open
- **THEN** the system cancels that transaction at Paddle before it deletes the cell
- **AND** it deletes the cell only after Paddle proves that the transaction cannot pay for it: Paddle cancelled it, reports it under another owner, or reports its subscription as ended
- **AND** the cell stays read-only for any other answer, including a payment that Paddle has not finished and an unanswered request
- **AND** each sweep gives Paddle a fixed time budget, and the cells it does not reach wait for the next sweep

#### Scenario: Paid resubscription without its subscription event

- **WHEN** an ended owner's resubscribe checkout completed for a new subscription, and Paddle's subscription event never arrives
- **THEN** the checkout return, the next checkout request or the lapsed-window sweep binds that subscription to the owner and reconciles it from Paddle
- **AND** the kept cell resumes

#### Scenario: Owner confirms deletion while checkout is open

- **WHEN** an owner confirms the account's deletion before or while checkout reopens a transaction
- **THEN** the server refuses and returns no payable checkout

#### Scenario: Deletion finishes with a resubscribe checkout bound

- **WHEN** the deletion of an ended owner's account finishes while a resubscribe transaction is bound to it
- **THEN** the system cancels that transaction at Paddle, or cancels at once the subscription it already paid for, before it scrubs the account
- **AND** the deletion waits while Paddle gives no proof

#### Scenario: Unpaid holds expire within a time budget

- **WHEN** the reconcile cron expires unpaid holds whose checkouts Paddle must settle
- **THEN** every Paddle call of the batch shares one time budget, and a hold that the budget does not reach stays stopped until the next run

#### Scenario: Friend discount changes after a checkout opened

- **WHEN** no regional friend price is configured and the legacy friend discount fails its checks when an owner reopens checkout
- **THEN** the server refuses with a stable error and never returns a checkout at the usual price

#### Scenario: Kept window has passed

- **WHEN** an ended owner starts checkout after the kept window
- **THEN** the server refuses with a stable error

#### Scenario: Owner already has a live subscription

- **WHEN** an owner with a live subscription requests checkout
- **THEN** the server refuses and creates no second subscription

### Requirement: Regional friend conversion preserves the existing subscription

The server SHALL read the live subscription before conversion and replace only the configured regular base item. It SHALL retain that item's quantity and every other item's identifier and quantity. It SHALL send the complete item list with `proration_billing_mode` set to `do_not_bill`. It MUST omit billing date, currency, customer and scheduled change fields. An unrelated existing promotion SHALL prevent conversion and leave the invitation usable.

#### Scenario: Owner has storage add-ons

- **WHEN** an eligible owner chooses the regional friend price
- **THEN** only the base price changes and no immediate charge occurs
- **AND** add-on quantities, currency and renewal date stay unchanged

#### Scenario: Provider response is lost

- **WHEN** the provider applies the friend price but its response is lost
- **THEN** a repeated use or keep decision reads provider facts before checking eligibility
- **AND** it records the applied friend price without another subscription update

#### Scenario: Another promotion is active

- **WHEN** the provider reports a discount other than the configured legacy friend discount
- **THEN** conversion sends no update and the invitation remains usable
