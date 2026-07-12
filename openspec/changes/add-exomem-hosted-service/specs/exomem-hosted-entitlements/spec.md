## ADDED Requirements

### Requirement: Exomem uses one provider-neutral entitlement projection

The control plane SHALL represent Exomem access as a product-scoped entitlement containing effective state, source, capabilities, resource limits, source revision, and timestamps. Cells and gateway request execution MUST consume only this provider-neutral projection.

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

Creating an Exomem checkout SHALL use server-configured active product and price identifiers. The authenticated caller MUST NOT choose an arbitrary price, product, tenant, or provider environment. The transaction SHALL contain server-generated product, user, and tenant correlation metadata.

#### Scenario: Owner starts checkout

- **WHEN** an entitled or trial owner requests Exomem checkout and a sandbox or live catalog is configured
- **THEN** the server creates a Paddle transaction for the configured Exomem price with internal correlation metadata and returns its hosted checkout URL

#### Scenario: Caller supplies a cheaper price ID

- **WHEN** a checkout request includes a caller-selected price or product identifier
- **THEN** the field is ignored or rejected and cannot affect the server-selected catalog item

#### Scenario: No paid catalog is configured

- **WHEN** checkout is requested before an active Exomem price is configured
- **THEN** the system returns a stable billing-unavailable response
- **AND** complimentary access and normal Exomem request execution remain unaffected

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

### Requirement: Billing identifiers stay out of cells and vaults

Paddle customer, subscription, transaction, product, and price identifiers SHALL remain within product-scoped control-plane billing state. They MUST NOT be included in cell forwarding context, Exomem commands, exports, vault content, transfer grants, or content-bearing logs.

#### Scenario: Checkout and capture occur in one session

- **WHEN** an owner completes checkout and later captures memory
- **THEN** billing identifiers are available only to billing/account surfaces
- **AND** the cell request and resulting canonical files contain none of them

### Requirement: Sandbox and live catalogs are explicitly separated

The Paddle adapter SHALL select sandbox or live API endpoints, credentials, webhook secrets, client tokens, and catalog IDs from one explicit environment. Sandbox events MUST NOT activate live entitlements and live code MUST NOT silently fall back to sandbox.

#### Scenario: Sandbox checkout is configured

- **WHEN** the environment is `sandbox`
- **THEN** transaction and portal calls use sandbox credentials and sandbox Exomem catalog identifiers

#### Scenario: Environment configuration is mixed

- **WHEN** a live environment receives a sandbox catalog ID or incompatible credential configuration detectable at startup or checkout
- **THEN** billing fails closed with a stable configuration error
