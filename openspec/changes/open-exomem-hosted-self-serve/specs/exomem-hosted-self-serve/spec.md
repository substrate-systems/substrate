## ADDED Requirements

### Requirement: Admission Is Decided Before Payment

The system SHALL decide whether a visitor can be provisioned before offering any payment surface. When capacity is exhausted the visitor MUST be waitlisted, and a payment surface MUST NOT be presented. Capacity exhaustion MUST NOT be discoverable only after a charge.

#### Scenario: Capacity is available

- **WHEN** a visitor requests access and an attachment slot is free
- **THEN** they are admitted and a checkout surface is offered

#### Scenario: Capacity is exhausted

- **WHEN** a visitor requests access and no attachment slot is free
- **THEN** they are waitlisted and told so plainly
- **AND** no checkout surface is offered and no charge is attempted

#### Scenario: Capacity is exhausted between admission and payment

- **WHEN** the last slot is taken after a visitor is admitted but before their payment settles
- **THEN** the settled payment still yields a provisioned cell, or is refunded automatically with the customer told
- **AND** the customer is never left holding a paid entitlement that cannot be provisioned

### Requirement: An Anonymous Purchase Creates Its Own Tenant

A first subscription event SHALL create the buyer's user and tenant when no internal correlation identifiers are present, resolving the buyer's identity from the payment provider's customer record. A transient failure to resolve that identity MUST surface as a retryable failure so the provider retries, and MUST NOT be recorded as a successful no-op.

#### Scenario: First subscription with no prior account

- **WHEN** a subscription event arrives whose custom data carries no internal user or tenant identifier
- **THEN** the buyer's email is resolved from the provider customer record
- **AND** a user and tenant are created and the entitlement is applied to them

#### Scenario: Identity lookup fails transiently

- **WHEN** the provider customer lookup fails or returns no email
- **THEN** the webhook reports a retryable failure
- **AND** no tenant is created and the event is not marked processed

#### Scenario: Existing correlation still wins

- **WHEN** an event carries valid internal user and tenant identifiers
- **THEN** they are used unchanged and no new tenant is created

#### Scenario: Replay does not duplicate

- **WHEN** the same first-subscription event is delivered more than once
- **THEN** exactly one user and one tenant exist for that buyer

### Requirement: The Public Product Is Honestly Purchasable

The public product page SHALL present Exomem Hosted as purchasable at a stated price, and structured data MUST agree with that price. The page MUST NOT describe the service as a trial, demo, or private alpha while it is publicly listed. Where a price is time-limited, the page MUST say so.

#### Scenario: A visitor can see what it costs

- **WHEN** a visitor reaches the public product page
- **THEN** the price and billing period are stated
- **AND** the structured data carries the same price

#### Scenario: Founder pricing is disclosed as temporary

- **WHEN** the offered price is a time-limited founder rate
- **THEN** the page states that it is time-limited and that existing subscriptions keep it

#### Scenario: No trial framing while listed

- **WHEN** the public product page is served
- **THEN** it does not describe the service as a trial, demo, or invite-only alpha

### Requirement: Purchase Completes At A Working Client Connection

After a successful purchase the system SHALL give the customer an install action for each supported client, on a post-checkout surface, in a welcome message, and in the account home. Install actions MUST be backed by live promoted client artifacts and MUST be hidden rather than shown broken when no such artifact exists.

#### Scenario: Post-checkout onboarding

- **WHEN** a purchase settles
- **THEN** the customer reaches a surface offering the install action for each supported client

#### Scenario: Onboarding survives leaving the page

- **WHEN** the customer closes the browser before installing
- **THEN** a welcome message delivers the same install action
- **AND** the account home continues to offer it

#### Scenario: No promoted artifact

- **WHEN** a client has no live promoted artifact
- **THEN** its install action is absent rather than shown as a broken link

### Requirement: Provisioning Delay Is Visible To The Customer

Because provisioning advances on an external schedule, the system SHALL show a truthful lifecycle state after purchase, and MUST distinguish a cell still being prepared from one that has failed. A stalled scheduler MUST be detectable rather than presenting as indefinite preparation.

#### Scenario: Cell is still preparing

- **WHEN** a paid tenant has no ready cell yet
- **THEN** the customer sees a preparing state with a support reference

#### Scenario: Preparation exceeds its expected window

- **WHEN** preparation exceeds the documented window
- **THEN** the state is reported as degraded rather than preparing
- **AND** the condition is surfaced to the operator
