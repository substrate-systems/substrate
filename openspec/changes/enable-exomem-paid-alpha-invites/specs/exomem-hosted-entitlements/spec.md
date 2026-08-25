## MODIFIED Requirements

### Requirement: The server selects Paddle catalog items

Creating an Exomem checkout SHALL reuse the server-configured active Exomem product
and price identifiers for an authenticated paid operator invitee. The authenticated caller
MUST NOT choose an arbitrary plan, price, product, tenant, provider environment, or
return URL. The transaction SHALL contain server-generated product, user, tenant,
and checkout correlation metadata, and the control plane SHALL atomically bind
its identifier and provider environment to that owner before returning it. Binding
MUST serialize with tenant deletion. New checkout MUST be available only to an
awaiting-payment Paddle owner while the existing sale catalog configuration is
complete and public self-serve admission remains unavailable. A browser checkout return MUST be accepted only through
an authenticated, CSRF-protected request that proves the exact transaction remains
bound to the caller's tenant. Terminal inspection SHALL use the stored provider
environment and merchant transaction access without depending on current browser,
return-origin, or sale-catalog configuration; reopening a non-terminal transaction
SHALL still require the complete current checkout configuration and an exact catalog
and URL match.

#### Scenario: Awaiting-payment owner starts private-alpha checkout

- **WHEN** an authenticated paid operator invitee with a reserved allocation requests checkout while the live €5 catalog mapping is valid
- **THEN** the server creates or resumes a Paddle transaction for the configured €5 monthly price, atomically binds it to the owner and environment, and returns its hosted checkout URL
- **AND** it creates no lifecycle operation or provider resource

#### Scenario: Caller supplies a cheaper price ID

- **WHEN** a checkout request includes a caller-selected plan, price, product, tenant, environment, or return URL
- **THEN** the field is ignored or rejected and cannot affect the server-selected catalog item or correlation

#### Scenario: No paid catalog is configured

- **WHEN** checkout is requested before the €5 price and Exomem product are configured exactly
- **THEN** the system returns a stable billing-unavailable response
- **AND** complimentary access and normal Exomem request execution remain unaffected

#### Scenario: New checkout is disabled

- **WHEN** an awaiting-payment owner requests a new checkout while the existing sale catalog configuration is incomplete
- **THEN** the system returns a stable billing-unavailable response without creating or mutating a Paddle transaction

#### Scenario: Owner returns from checkout

- **WHEN** an authenticated owner returns with a transaction reference in the checkout URL
- **THEN** Home removes the reference from browser history and opens Paddle.js only after a CSRF-protected server check proves that exact transaction is still bound to the owner's tenant in the configured environment
- **AND** the return itself never grants entitlement or releases provisioning
- **AND** a transient validation or Paddle.js failure retains the candidate only in session-scoped browser state and offers explicit retry or dismissal, with retry revalidating before any checkout opens

#### Scenario: Pending checkout was canceled

- **WHEN** the transaction bound to a tenant is terminally canceled before checkout resumes
- **THEN** the control plane compare-and-clears that exact reference
- **AND** an explicit new-checkout request may bind one replacement while an authenticated checkout return settles back to Home without opening Paddle.js
- **AND** the terminal return remains recoverable after the active checkout catalog, browser token, or public return origin rotates away
- **AND** a concurrent replacement or deletion cannot be overwritten

#### Scenario: Pending checkout completed before checkout resumes

- **WHEN** the transaction bound to a tenant is already completed and identifies its subscription
- **THEN** the control plane promotes the subscription and customer references, durably schedules and attempts immediate reconciliation, settles an authenticated checkout return back to Home even if that immediate attempt is transiently unavailable, and does not create a second transaction
- **AND** provisioning is released only by the same authoritative activation projection used for a verified webhook or reconciliation observation
- **AND** the terminal return remains recoverable after the active checkout catalog, browser token, or public return origin rotates away

### Requirement: Paddle webhooks project Exomem state idempotently

The shared Paddle webhook SHALL verify the signature before dispatch, identify
Exomem events through trusted catalog and custom metadata, store event identity
idempotently, correlate the event to the authoritative tenant and exact bound
transaction or existing subscription, and update the entitlement using monotonic
event and revision handling. The first authoritative active or trialing
paid Exomem subscription projection SHALL, in the same database transaction,
claim the event receipt, bind provider references, activate the entitlement, pin the
live Hosted target, create exactly one initial provisioning operation, and attach
the reserved allocation to that operation. If the reservation, transaction correlation, or
live target is missing, processing MUST fail before commit so the event remains
retryable. Webhook and reconciliation processing MUST remain enabled when new
new checkout is disabled. Existing Endstate event behavior MUST be preserved.

#### Scenario: Subscription created activates a paid tenant

- **WHEN** a verified subscription.created event carries an active or trialing subscription correlated to the exact bound paid-invite transaction and reserved tenant
- **THEN** the event, provider references, active entitlement, one pinned initial operation, and allocation attachment commit atomically
- **AND** the existing lifecycle reconciler may begin provisioning only after that commit

#### Scenario: Subscription activated arrives first

- **WHEN** a verified subscription.activated event is the first subscription event for the exact bound paid-invite transaction
- **THEN** the system may establish the subscription correlation and perform the same atomic activation and provisioning release
- **AND** it does not depend on subscription.created arriving first

#### Scenario: Activation lacks its reservation or live target

- **WHEN** an otherwise valid activation cannot resolve the reserved allocation or configured live Hosted target
- **THEN** processing rolls back and returns a retryable failure without recording the event receipt
- **AND** no partial entitlement activation or lifecycle operation remains

#### Scenario: Duplicate event arrives

- **WHEN** Paddle redelivers an already-applied event ID or activation revision
- **THEN** the webhook acknowledges it without applying the transition twice or creating another operation

#### Scenario: Older event arrives after a newer event

- **WHEN** an older provider event would reverse a transition already established by a newer revision
- **THEN** the older event is retained for audit but does not replace the effective entitlement or alter the attached operation

#### Scenario: Endstate event arrives

- **WHEN** a verified webhook belongs to the existing Endstate catalog
- **THEN** it follows the existing Endstate handler and does not create or mutate an Exomem entitlement, allocation, or lifecycle operation
