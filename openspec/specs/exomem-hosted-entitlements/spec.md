# exomem-hosted-entitlements Specification

## Purpose

Define provider-neutral Exomem access, Paddle checkout and reconciliation boundaries, environment provenance, and safe billing termination.

## Requirements

### Requirement: Exomem uses one provider-neutral entitlement projection

The control plane SHALL represent Exomem access as a product-scoped entitlement containing effective state, source, capabilities, resource limits, source revision, provider references with their environment provenance, and timestamps. Cells and gateway request execution MUST consume only the provider-neutral capability projection.

#### Scenario: Complimentary alpha tenant is active

- **WHEN** an invite grants complimentary alpha access
- **THEN** the tenant receives the configured alpha capabilities and limits without a Paddle customer or subscription

#### Scenario: Paid provider changes later

- **WHEN** Paddle or another billing adapter changes provider-specific identifiers or events
- **THEN** the gateway and cell continue to consume the same capability and limit shape

### Requirement: Complimentary access and paid access share enforcement

Complimentary and Paddle-backed entitlements SHALL pass through the same effective-state and capability evaluation. No hidden test bypass MAY grant broader runtime access than an explicit entitlement row.

#### Scenario: Complimentary grant permits capture and recall

- **WHEN** a valid complimentary entitlement grants capture and recall
- **THEN** the gateway authorizes those operations through the normal entitlement gate

#### Scenario: Complimentary grant is revoked

- **WHEN** an operator revokes or suspends the grant
- **THEN** new operations are denied according to the resulting effective state without editing vault content

### Requirement: The server selects Paddle catalog items

Creating an Exomem checkout SHALL use server-configured active product and price identifiers. The authenticated caller MUST NOT choose an arbitrary price, product, tenant, or provider environment. The transaction SHALL contain server-generated product, user, and tenant correlation metadata, and the control plane SHALL atomically bind its identifier and provider environment to that owner before returning it. Binding MUST serialize with tenant deletion. A browser checkout return MUST be accepted only through an authenticated, CSRF-protected request that proves the exact transaction remains bound to the caller's tenant. Terminal inspection SHALL use the stored provider environment and merchant transaction access without depending on current browser, return-origin, or sale-catalog configuration; reopening a non-terminal transaction SHALL still require the complete current checkout configuration and an exact catalog and URL match.

#### Scenario: Owner starts checkout

- **WHEN** an entitled or trial owner requests Exomem checkout and a sandbox or live catalog is configured
- **THEN** the server creates a Paddle transaction for the configured Exomem price with internal correlation metadata, atomically binds it to the owner and provider environment, and returns its hosted checkout URL

#### Scenario: Caller supplies a cheaper price ID

- **WHEN** a checkout request includes a caller-selected price or product identifier
- **THEN** the field is ignored or rejected and cannot affect the server-selected catalog item

#### Scenario: No paid catalog is configured

- **WHEN** checkout is requested before an active Exomem price is configured
- **THEN** the system returns a stable billing-unavailable response
- **AND** complimentary access and normal Exomem request execution remain unaffected

#### Scenario: Owner returns from checkout

- **WHEN** an authenticated owner returns with a transaction reference in the checkout URL
- **THEN** Home removes the reference from browser history and opens Paddle.js only after a CSRF-protected server check proves that exact transaction is still bound to the owner's tenant in the configured environment
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
- **AND** the terminal return remains recoverable after the active checkout catalog, browser token, or public return origin rotates away

### Requirement: Paddle webhooks project Exomem state idempotently

The shared Paddle webhook SHALL verify the signature before dispatch, identify Exomem events through trusted catalog/custom metadata, store event identity idempotently, correlate the event to the authoritative tenant, and update the entitlement using monotonic event/revision handling. It MUST preserve existing Endstate event behavior.

#### Scenario: First Exomem subscription event arrives

- **WHEN** a verified event carries valid Exomem product metadata and a tenant correlation matching the authenticated checkout
- **THEN** the event is recorded once and the corresponding Exomem entitlement is projected to the mapped provider state

#### Scenario: Duplicate event arrives

- **WHEN** Paddle redelivers an already-applied event ID
- **THEN** the webhook acknowledges it without applying the transition twice

#### Scenario: Older event arrives after a newer event

- **WHEN** an older provider event would reverse a transition already established by a newer revision
- **THEN** the older event is retained for audit but does not replace the effective entitlement

#### Scenario: Endstate event arrives

- **WHEN** a verified webhook belongs to the existing Endstate catalog
- **THEN** it follows the existing Endstate handler and does not create or mutate an Exomem entitlement

### Requirement: Manual suspension dominates provider state

An authorized control-plane suspension SHALL deny routed service regardless of Paddle or complimentary source state. Clearing a manual suspension SHALL recompute access from the latest valid source projection rather than assuming active.

#### Scenario: Active paid tenant is manually suspended

- **WHEN** an operator or security workflow sets manual suspension
- **THEN** the gateway stops new routed operations and lifecycle state reflects suspension even if Paddle remains active

#### Scenario: Manual suspension is lifted

- **WHEN** the suspension is cleared
- **THEN** the system derives the effective state from the current complimentary or Paddle source state and capability policy

### Requirement: Grace and cancellation preserve explicit capability policy

Provider states such as past-due, paused, and cancelled SHALL map to explicit Exomem effective states and capability sets. Read, export, and write behavior MUST be deterministic and testable rather than inferred ad hoc in routes.

#### Scenario: Tenant enters billing grace

- **WHEN** a verified provider transition enters grace
- **THEN** the configured grace capabilities are applied consistently, including any read/export retention and write restriction

#### Scenario: Subscription is cancelled

- **WHEN** the provider cancellation becomes effective
- **THEN** the entitlement becomes cancelled or suspended according to policy, paid-only operations stop, and account deletion is not triggered automatically

### Requirement: Normal Exomem operations do not call Paddle

Capture, recall, browse, upload, download, readiness, export polling, and Home rendering MUST read internal entitlement state only. Paddle calls SHALL be confined to checkout, customer-portal, explicit reconciliation, and webhook-adapter workflows.

#### Scenario: Paddle API is unavailable during recall

- **WHEN** an active tenant recalls memory while Paddle is unavailable
- **THEN** recall proceeds using the last authoritative internal entitlement without contacting Paddle

### Requirement: Paddle reconciliation is durable, exclusive, and bounded

Eligible Paddle-backed entitlements SHALL be reconciled from durable next-check and retry state. Overlapping cron invocations MUST NOT reconcile the same subscription concurrently. A successful provider observation SHALL schedule the next periodic check, a failed observation SHALL use bounded retry backoff, and the provider request SHALL inherit the remaining reconciliation deadline. Every provider call MUST use the environment stored with the referenced transaction, customer, or subscription. Missing Paddle configuration, unresolved legacy provenance, or a stored/configured environment mismatch while eligible paid entitlements remain MUST fail visibly before any provider call rather than silently skipping or guessing.

#### Scenario: Two cron invocations overlap

- **WHEN** two authenticated reconciliation invocations select the same due subscription
- **THEN** an exclusive expiring lease allows only one invocation to call Paddle
- **AND** an abandoned lease becomes eligible for safe retry

#### Scenario: Reconciliation fails transiently

- **WHEN** Paddle is unavailable or returns an invalid observation
- **THEN** the entitlement retains its last authoritative projection
- **AND** the next attempt is scheduled with exponential backoff capped at six hours

#### Scenario: Tenant deletion starts during a provider request

- **WHEN** a tenant becomes deletion-pending after its subscription was claimed but before the observation is projected
- **THEN** the atomic projection records the reconciliation as ignored and leaves the deletion-closed entitlement unchanged

#### Scenario: Paid configuration disappears

- **WHEN** an eligible Paddle-backed entitlement exists but the configured Exomem Paddle product is absent
- **THEN** reconciliation reports a stable control-plane failure instead of returning an unconfigured no-op

#### Scenario: Provider provenance is unresolved

- **WHEN** a legacy Paddle-backed entitlement has provider references but no environment can be proven from an exact receipt or verified event
- **THEN** reconciliation reports a stable control-plane failure before calling Paddle
- **AND** it does not infer an environment from the current deployment setting
- **AND** suspension or deletion can still close local routing while provider termination remains pending for manual provenance repair

#### Scenario: Stored and configured environments differ

- **WHEN** a subscription was recorded in one Paddle environment but the active adapter is configured for another
- **THEN** checkout recovery, portal creation, reconciliation, and deletion fail closed before making a provider call

### Requirement: Billing identifiers stay out of cells and vaults

Paddle customer, subscription, transaction, product, and price identifiers SHALL remain within product-scoped control-plane billing state. They MUST NOT be included in cell forwarding context, Exomem commands, exports, vault content, transfer grants, or content-bearing logs.

#### Scenario: Checkout and capture occur in one session

- **WHEN** an owner completes checkout and later captures memory
- **THEN** billing identifiers are available only to billing/account surfaces
- **AND** the cell request and resulting canonical files contain none of them

### Requirement: Sandbox and live catalogs are explicitly separated

The Paddle adapter SHALL select sandbox or live API endpoints, credentials, webhook secrets, client tokens, and catalog IDs from one explicit environment. The control plane SHALL persist that environment alongside every Paddle transaction, customer, and subscription reference, including exact provenance repaired from a verified webhook. Sandbox events MUST NOT activate live entitlements and live code MUST NOT silently fall back to sandbox.

#### Scenario: Sandbox checkout is configured

- **WHEN** the environment is `sandbox`
- **THEN** transaction and portal calls use sandbox credentials and sandbox Exomem catalog identifiers

#### Scenario: Environment configuration is mixed

- **WHEN** a live environment receives a sandbox catalog ID or incompatible credential configuration detectable at startup or checkout
- **THEN** billing fails closed with a stable configuration error

### Requirement: Billing termination precedes tenant destruction

Product-scoped deletion SHALL serialize against checkout binding and terminate the exact provider billing reference in its stored environment before destroying the tenant cell. A pending transaction MUST be canceled; if it completed concurrently, its discovered subscription MUST be canceled instead. The control plane MUST compare the complete billing-reference fingerprint, mark billing terminated, scrub the terminated provider references, and advance the leased deletion checkpoint in one atomic transaction so a webhook or checkout race cannot be mistaken for termination or reattach billing after the gate.

#### Scenario: Deletion starts before checkout binding

- **WHEN** deletion locks the tenant before a newly created Paddle transaction can be bound
- **THEN** the transaction is not retained as an authoritative tenant reference and checkout fails closed

#### Scenario: Deletion starts with a pending transaction

- **WHEN** a deletion-pending tenant has a draft or ready Paddle transaction
- **THEN** the control plane owner-validates and cancels that exact transaction before cell destruction
- **AND** disabling or rotating the currently saleable price does not disable cleanup of the stored transaction

#### Scenario: Provider returns not found during termination

- **WHEN** the configured Paddle account returns not found for a retained transaction or subscription
- **THEN** deletion treats the response as unverified rather than proof of cancellation
- **AND** cell destruction remains pending because environment provenance alone does not prove the merchant account

#### Scenario: Checkout completes while deletion is canceling billing

- **WHEN** the pending transaction completes or a webhook promotes a subscription during deletion
- **THEN** deletion discovers and cancels the subscription or its atomic fingerprint-and-checkpoint transition fails for a safe retry
- **AND** deletion does not advance from stale termination evidence

#### Scenario: Billing proof and deletion checkpoint commit together

- **WHEN** provider termination succeeds and the exact stored fingerprint still matches under the current deletion lease and fence
- **THEN** one transaction marks billing terminated, scrubs the dead provider references, and advances `local-gated` to `billing-terminated`
- **AND** no intermediate state exposes a terminated marker with an unadvanced checkpoint or an advanced checkpoint with stale provider references
