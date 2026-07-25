# conversion-analytics Specification

## Purpose

Observe the web acquisition-to-purchase funnel and operational outcomes without identifying
people, weakening privacy boundaries, adding local-product telemetry, or degrading the flows
being measured.

## Requirements

### Requirement: Analytics never degrades the flow it observes

Analytics SHALL remain a best-effort observer. A missing key, failed request, or slow PostHog response SHALL NOT change a checkout, webhook, download, cron, or page interaction outcome.

#### Scenario: PostHog is unreachable during checkout

- **WHEN** a visitor opens a Paddle checkout while PostHog is unavailable
- **THEN** checkout behaviour remains unchanged
- **AND** no analytics error is surfaced to the visitor

#### Scenario: PostHog is unreachable during a webhook

- **WHEN** analytics delivery fails after a webhook's business effect
- **THEN** the handler still returns its normal acknowledgement
- **AND** the business effect remains applied

#### Scenario: Server capture is slow

- **WHEN** a server-side event cannot flush promptly
- **THEN** the request waits no longer than the configured analytics flush bound

### Requirement: Funnel correlation remains anonymous

The system SHALL correlate website and payment-provider events with PostHog's anonymous browser `distinct_id` when available. It SHALL NOT introduce a person identity model for this funnel.

#### Scenario: Web checkout carries an anonymous id

- **WHEN** a visitor with an established anonymous PostHog id opens checkout
- **THEN** that id is passed to Paddle as custom data
- **AND** the matching subscription or supporter webhook uses it as the server event's `distinctId`

#### Scenario: Anonymous id is unavailable

- **WHEN** the SDK is blocked, uninitialised, or has no id
- **THEN** checkout still proceeds
- **AND** the server event is recorded as unresolved rather than assigned to a fabricated person

#### Scenario: A visitor becomes an account holder or supporter

- **WHEN** a claim, sign-in, subscription, or supporter purchase succeeds
- **THEN** analytics does not call `identify()`
- **AND** no account id, email, Paddle customer id, licence id, or machine id is sent as a PostHog identity
- **AND** server events explicitly disable PostHog person-profile processing

### Requirement: Revenue and operational outcomes are captured server-side

Provider and scheduled outcomes SHALL be captured on the server after the business effect or authentication check they observe.

#### Scenario: Paddle subscription transition

- **WHEN** a handled subscription lifecycle webhook is persisted
- **THEN** a `subscription_changed` event records the transition and resulting status

#### Scenario: Supporter purchase

- **WHEN** Paddle delivers a completed recognition-only supporter purchase
- **THEN** a `supporter_purchased` event is captured
- **AND** no licence key or entitlement is issued

#### Scenario: Scheduled job completes

- **WHEN** an authenticated cron route finishes
- **THEN** a `cron_completed` event records the job and outcome

#### Scenario: Installed product checks for an update

- **WHEN** `/updates/latest.json` serves or fails an update check
- **THEN** an aggregate `update_checked` event records only the outcome
- **AND** no persistent caller or machine identifier is introduced

### Requirement: The checkout funnel records failures as well as success

Every checkout stage SHALL be observable so abandonment can be distinguished from breakage.

#### Scenario: Checkout begins or completes

- **WHEN** a visitor activates a purchase control or Paddle reports browser completion
- **THEN** the corresponding `checkout_started` or `checkout_completed` event is captured

#### Scenario: Checkout fails

- **WHEN** Paddle SDK initialisation, price resolution, or checkout opening fails
- **THEN** `checkout_failed` records the product and failure stage

#### Scenario: Transaction checkout is retried

- **WHEN** a visitor retries a failed transaction checkout
- **THEN** the retry is captured before another open attempt

### Requirement: The installed product carries no telemetry

Endstate's CLI and GUI SHALL receive no analytics identifier and SHALL introduce no persistent per-install tracking identity.

#### Scenario: Claim handoff enters the desktop application

- **WHEN** the website opens an `endstate://claim` deep link
- **THEN** the link contains only fields functionally required for the claim
- **AND** it contains no analytics id, session id, device id, or campaign parameter

#### Scenario: Website observes the handoff control

- **WHEN** a visitor activates the website's handoff or copy control
- **THEN** the website MAY capture that interaction
- **AND** the token or copied credential is not included in the event

### Requirement: Sensitive routes are protected from automatic capture

Private Exomem routes SHALL emit no PostHog events. Routes that render claim tokens or account email SHALL reject autocapture while retaining audited pageviews and deliberate events.

#### Scenario: Event belongs to a private Exomem route

- **WHEN** an event's current URL or event URL is a private Exomem path
- **THEN** the event is dropped before transmission

#### Scenario: Sensitive text is rendered on a measured route

- **WHEN** `/account` or `/endstate/claim/[token]` is active
- **THEN** PostHog autocapture is disabled for that URL
- **AND** deliberate events contain no rendered credential or account email

#### Scenario: Session replay is considered

- **WHEN** secret-bearing surfaces are not independently block-listed and verified
- **THEN** session replay remains disabled

### Requirement: Unmet supported-app demand is observable

Supported-app searches SHALL be captured after the query settles, including the zero-result case.

#### Scenario: Search returns results

- **WHEN** a visitor's non-empty search settles with matches
- **THEN** one `apps_searched` event records the query and result count

#### Scenario: Search returns no results

- **WHEN** a visitor's non-empty search settles without matches
- **THEN** `apps_search_no_results` records the unmet query

#### Scenario: Supported-app page first renders

- **WHEN** no visitor search has occurred
- **THEN** no search analytics event is emitted

### Requirement: Analytics-enabled environments use the project region

Deployments that enable PostHog SHALL configure both the project key and the matching regional host. Environments without the project key SHALL no-op.

#### Scenario: Analytics is configured

- **WHEN** a deployment has a PostHog project key
- **THEN** its client SDK and ingest proxy target the configured project host

#### Scenario: Analytics is intentionally disabled

- **WHEN** a deployment has no PostHog project key
- **THEN** capture helpers no-op without changing application behaviour
