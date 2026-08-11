## ADDED Requirements

### Requirement: Voluntary project support is named Support Endstate

Public copy SHALL name voluntary contributions to the project "Support
Endstate" and SHALL NOT use the phrase "Supporter License". Support SHALL be
presented as separate from the product and service plans, not as a plan
alongside them.

#### Scenario: Pricing separates support from plans

- **WHEN** the Endstate pricing section is rendered
- **THEN** the contribution card is titled "Support Endstate"
- **AND** its call to action leads to the supporters page rather than opening a
  checkout in the pricing grid

#### Scenario: Terms names the contribution

- **WHEN** the Terms page is rendered
- **THEN** its definitions, terms of service, and refund sections name the
  contribution "Support Endstate"
- **AND** none of them use the phrase "Supporter License"

### Requirement: Supporting Endstate grants nothing

Support Endstate SHALL create no licence key, entitlement, local feature flag,
payment check in the desktop application, supporter-only functionality,
recurring obligation, private call, or priority-engineering promise. Public copy
SHALL state that supporting unlocks nothing.

#### Scenario: The contribution surface makes the absence explicit

- **WHEN** the Support Endstate section of the supporters page is rendered
- **THEN** it states that supporting is not a licence, unlocks no features,
  carries no recurring obligation, and is not checked by the product

#### Scenario: A completed contribution issues no entitlement

- **GIVEN** a signed `transaction.completed` event containing a configured
  support price
- **WHEN** it reaches `/api/license/webhook`
- **THEN** the founder notification and contributor thank-you are sent
- **AND** no licence key, entitlement, or subscription record is created

### Requirement: Contribution amounts are config-driven and degrade gracefully

The contribution amounts SHALL be defined as a configuration-driven array of
tiers — €10 Supporter, €29 Founding Supporter, and €89 Patron — where each tier
resolves its Paddle price identifier from an environment variable. A tier SHALL
render only when its price identifier is configured. The page SHALL render
correctly when some price identifiers are absent.

The €89 tier SHALL continue to read `NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER`
unchanged, so existing support records stay valid.

#### Scenario: An unconfigured tier is not offered

- **GIVEN** `NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10` is not configured
- **WHEN** the Support Endstate section is rendered
- **THEN** the €10 Supporter tier is not shown
- **AND** the remaining configured tiers and the Custom Project Sponsor option
  are shown

#### Scenario: A newly configured tier appears without a code change

- **GIVEN** `NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10` is configured and the
  application is rebuilt
- **WHEN** the Support Endstate section is rendered
- **THEN** the €10 Supporter tier is shown with a working checkout button

#### Scenario: The entry amount reflects configuration

- **WHEN** the Support Endstate pricing card is rendered
- **THEN** it shows the lowest configured contribution amount

### Requirement: Custom Project Sponsor routes to the existing contact path

The Custom Project Sponsor option SHALL be a `mailto:founder@substratesystems.io`
link carrying a prefilled subject. It SHALL NOT open an arbitrary-amount
checkout, and SHALL NOT introduce a form, API route, or stored record.

#### Scenario: The custom option opens a mail draft

- **WHEN** the Custom Project Sponsor option is rendered
- **THEN** its link target is a `mailto:founder@substratesystems.io` address with
  a prefilled subject naming custom sponsorship

### Requirement: The webhook accepts every configured support price

`/api/license/webhook` SHALL treat a `transaction.completed` event as a support
contribution when it contains any configured support price identifier, including
the pre-existing €89 price. When no support price is configured it SHALL return
a retryable server error rather than acknowledging and discarding the purchase.

#### Scenario: The pre-existing price is still handled

- **GIVEN** only `NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER` is configured
- **WHEN** a signed `transaction.completed` event containing that price arrives
- **THEN** the recognition-only support flow runs and the endpoint returns 200

#### Scenario: A newly configured price is also handled

- **GIVEN** `NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10` is configured
- **WHEN** a signed `transaction.completed` event containing that price arrives
- **THEN** the recognition-only support flow runs and the endpoint returns 200

#### Scenario: No support price is configured

- **GIVEN** no support price identifier is configured
- **WHEN** a signed `transaction.completed` event arrives
- **THEN** the endpoint returns a retryable server error
- **AND** no notification email is sent

#### Scenario: An unrelated one-time purchase is ignored

- **WHEN** a signed `transaction.completed` event containing no configured
  support price arrives
- **THEN** the endpoint returns a successful ignored response and sends no email

### Requirement: Supporter recognition stays opt-in and sourced from the engine repository

The supporters page SHALL continue to render the list parsed from the
`## Supporters` heading of `SUPPORTERS.md` in the Endstate engine repository.
Recognition SHALL remain opt-in and consent-based, and public copy SHALL say so.

#### Scenario: The list is parsed from the engine repository

- **WHEN** the supporters page is rendered
- **THEN** it fetches `SUPPORTERS.md` from the Endstate engine repository and
  lists the entries under its `## Supporters` heading

#### Scenario: Consent is stated

- **WHEN** the supporters page is rendered
- **THEN** it states that listing is opt-in

### Requirement: The first €89 contribution is preserved as Patron

An operator-confirmed, idempotent import SHALL accept the original Paddle
transaction identity, webhook event identity, and occurrence timestamp for the
pre-tier €89 purchase. It SHALL store a `patron` contribution without issuing a
licence or entitlement, retain the original timestamp, and mark historical
email obligations fulfilled so the import never sends duplicate mail. Public
recognition SHALL remain pending explicit consent.

#### Scenario: importing the first supporter is replay-safe

- **GIVEN** the verified original transaction ID, event ID, and occurrence time
- **WHEN** an operator runs the confirmed Patron import twice
- **THEN** exactly one Patron contribution record exists
- **AND** no new checkout, provider mutation, or email delivery occurs
- **AND** no name is added to `SUPPORTERS.md` without reply-based consent

### Requirement: Contributor recognition consent is requested by email

The contributor thank-you SHALL say that supporting unlocks nothing and SHALL
ask the contributor to reply with explicit permission and the name to display
before public recognition is added.

#### Scenario: thank-you does not infer recognition consent

- **WHEN** a contributor thank-you is delivered
- **THEN** it asks for a reply such as “yes, add my name”
- **AND** it says the name will not be added without permission

### Requirement: Supporter email obligations remain observable until delivered

The supporter email outbox SHALL retry unsent founder and contributor mail with
bounded exponential backoff. It SHALL not silently cap retries. After a named
failure threshold it SHALL mark the row for operator attention, include the
unresolved count in the authenticated cron outcome, and continue retrying
without allowing a poison row to starve newer eligible deliveries.

#### Scenario: repeated mail failure is visible and still retryable

- **GIVEN** a supporter email has failed at least ten times
- **WHEN** the follow-up cron runs
- **THEN** the row remains eligible after its scheduled backoff
- **AND** the operator-attention count includes it
