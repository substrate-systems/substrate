## ADDED Requirements

### Requirement: Analytics never degrades the flow it observes

Analytics is an observer. A capture failure, a slow PostHog response, or a missing configuration key SHALL NOT change the outcome of any user-facing or provider-facing operation.

#### Scenario: PostHog is unreachable during checkout
- **WHEN** a user opens the Paddle checkout and every PostHog request times out
- **THEN** the checkout opens and completes normally
- **AND** no error surfaces to the user

#### Scenario: PostHog is unreachable during a webhook
- **WHEN** Paddle delivers a subscription webhook and the analytics capture throws
- **THEN** the handler still acknowledges the webhook with its normal success status
- **AND** the subscription state change is still persisted

#### Scenario: Analytics key is not configured
- **WHEN** `NEXT_PUBLIC_POSTHOG_KEY` is unset
- **THEN** every capture call no-ops
- **AND** all flows behave identically to a configured deployment

#### Scenario: A capture is slow
- **WHEN** a server-side capture is issued on a user-facing request path
- **THEN** the request SHALL NOT be delayed by more than the configured flush bound

### Requirement: Private routes are never observed

Analytics SHALL NOT record any event whose current URL or event URL is a private Exomem path, regardless of which capture mechanism produced it.

#### Scenario: Automatic capture on a private route
- **WHEN** any automatic capture (pageview, pageleave, autocapture, replay, exception) fires while the current URL is a private Exomem path
- **THEN** the event is dropped before transmission

#### Scenario: Event carrying a private URL
- **WHEN** an event's `$current_url` property is a private Exomem path
- **THEN** the event is dropped before transmission, even if the page's current URL is public

#### Scenario: Navigation into a private route
- **WHEN** a visitor navigates from a public page into a private Exomem route
- **THEN** the analytics SDK is torn down
- **AND** no event describing the private route is transmitted

### Requirement: Revenue events are captured server-side

Subscription and licence lifecycle events SHALL be captured on the server, because they originate from provider callbacks rather than a browser.

#### Scenario: Paddle subscription webhook
- **WHEN** Paddle delivers a subscription lifecycle webhook
- **THEN** an event is captured naming the lifecycle transition
- **AND** the event carries the subscription's provider identifiers

#### Scenario: Licence webhook
- **WHEN** a lifetime-licence purchase webhook is delivered
- **THEN** an event is captured recording the purchase

#### Scenario: Scheduled job outcome
- **WHEN** a cron route completes
- **THEN** an event is captured recording whether it succeeded and what it processed

### Requirement: Identity is resolved at the point a visitor becomes a user

The system SHALL call `identify` when an anonymous visitor becomes an identifiable user, so that person profiles exist under `person_profiles: "identified_only"`.

#### Scenario: Claim redemption
- **WHEN** a user redeems a hosted-backup claim token
- **THEN** the browser session is identified against a stable user identifier
- **AND** the visitor's prior anonymous events are attributed to the resulting person

#### Scenario: Licence activation
- **WHEN** a licence is activated
- **THEN** an identified event is captured for that user

#### Scenario: Sign-out
- **WHEN** a user signs out
- **THEN** the analytics identity is reset so a subsequent visitor on the same device is not attributed to the previous user

### Requirement: The local product carries no telemetry and receives no identifiers

Endstate's CLI and GUI collect and transmit nothing. This is a published commitment — "No analytics, telemetry, or tracking in the local product" — and it is inviolable. Analytics work SHALL NOT weaken it, including by passing identifiers *into* the local product for a downstream system to correlate later.

The observable journey therefore ends at the web boundary, by design.

#### Scenario: Handoff to the desktop application
- **WHEN** a claim is handed off to the desktop app via the `endstate://` deep link
- **THEN** the link SHALL contain only what the claim functionally requires
- **AND** no analytics identifier, session id, device id, or campaign parameter is appended to it

#### Scenario: Attempt to correlate a desktop action back to a web visitor
- **WHEN** any future work proposes joining desktop-app activity to a web session
- **THEN** it is rejected at design time, because the local product transmits nothing that could complete such a join

#### Scenario: Publicly inspectable surfaces
- **WHEN** a user inspects a deep link, an installer request, or any artifact the local product touches
- **THEN** nothing they find contradicts the published no-telemetry claim

#### Scenario: Endpoints the installed application calls
- **WHEN** an endpoint exists that the installed CLI or GUI requests — the updater manifest at `/updates/latest.json` being the current one
- **THEN** it SHALL NOT be instrumented with analytics
- **AND** this holds even though such a capture would be server-side, because counting requests from installed applications is install telemetry in substance regardless of where the capture runs

### Requirement: Identity survives the crossing into the payment provider

A visitor's analytics identity SHALL be carried into the payment provider, so a purchase can be attributed to the acquisition channel that produced it. This boundary is between the website and a payment processor, and does not involve the local product.

#### Scenario: Web to payment provider
- **WHEN** a checkout is opened for a visitor with an established analytics identity
- **THEN** that identifier is passed to Paddle as custom data
- **AND** the resulting webhook event can be attributed to the same person as the visitor's browser events

#### Scenario: Identity unavailable
- **WHEN** no analytics identifier exists for the visitor, because the SDK was blocked or the visit is first-touch
- **THEN** the checkout still opens and completes
- **AND** the resulting server event is recorded as unresolved rather than being dropped or attributed to a fabricated person

### Requirement: The checkout funnel is observable including its failures

Every outcome of a checkout attempt SHALL be captured, not only successful ones, so that abandonment can be distinguished from breakage.

#### Scenario: Checkout intent
- **WHEN** a user activates a purchase control
- **THEN** an intent event is captured identifying which product and surface it was initiated from

#### Scenario: Checkout completed
- **WHEN** the payment provider reports checkout completion in the browser
- **THEN** a completion event is captured

#### Scenario: Checkout fails to initialise
- **WHEN** the payment provider SDK fails to initialise
- **THEN** a failure event is captured naming the failure stage

#### Scenario: Checkout fails to open
- **WHEN** opening the checkout throws
- **THEN** a failure event is captured naming the failure stage

#### Scenario: User retries after a failure
- **WHEN** a user activates the retry control on the checkout failure surface
- **THEN** a retry event is captured

### Requirement: Unmet demand on the supported-apps surface is recorded

Searches on the supported-apps page SHALL be captured, including searches that return no results, because unmet demand is a direct product-roadmap signal.

#### Scenario: Search returning results
- **WHEN** a user searches the supported-apps list and results are returned
- **THEN** a search event is captured with the query and the result count
- **AND** the capture is debounced so a single search does not emit one event per keystroke

#### Scenario: Search returning nothing
- **WHEN** a search returns no results
- **THEN** an event is captured identifying the query as unmet demand

### Requirement: Session replay is gated on content masking

Session replay SHALL NOT be enabled until surfaces that render secrets are masked, because replay records DOM content.

#### Scenario: Replay with unmasked secret-bearing surfaces
- **WHEN** masking rules do not cover surfaces rendering recovery keys, claim tokens, or account identifiers
- **THEN** session replay remains disabled

#### Scenario: Replay enabled
- **WHEN** replay is enabled after masking is in place
- **THEN** recovery keys, claim tokens, and account identifiers are masked in captured recordings
- **AND** replay does not run on private Exomem routes

### Requirement: Analytics is configured for the correct region in every environment

The analytics host SHALL resolve to the project's own PostHog region in every deployment environment, since an unset value falls back to a different region and misroutes silently.

#### Scenario: Environment with the host configured
- **WHEN** a deployment builds with the analytics host set
- **THEN** both the client SDK and the ingest proxy target that host

#### Scenario: Environment without the host configured
- **WHEN** a deployment environment is missing the analytics host variable
- **THEN** this is detectable before that environment serves traffic, rather than surfacing as silently absent data
