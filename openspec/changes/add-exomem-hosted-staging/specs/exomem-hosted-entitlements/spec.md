## MODIFIED Requirements

### Requirement: The server selects Paddle catalog items

Creating an Exomem checkout SHALL use server-configured active product and price identifiers. The authenticated caller MUST NOT choose an arbitrary price, product, tenant, or provider environment. The transaction SHALL contain server-generated product, user, and tenant correlation metadata, and the control plane SHALL atomically bind its identifier and provider environment to that owner before returning it. Binding MUST serialize with tenant deletion. A paid-enabled deployment MUST first verify from the selected Paddle environment that the configured product and price are active, mutually linked, monthly with frequency one, denominated in EUR, and exactly 500 cents. A browser checkout return MUST be accepted only through an authenticated, CSRF-protected request that proves the exact transaction remains bound to the caller's tenant. Terminal inspection SHALL use the stored provider environment and merchant transaction access without depending on current browser, return-origin, or sale-catalog configuration; reopening a non-terminal transaction SHALL still require the complete current checkout configuration and an exact catalog and URL match.

#### Scenario: Owner starts checkout

- **WHEN** an entitled or trial owner requests Exomem checkout and a sandbox or live catalog has passed the deployment catalog gate
- **THEN** the server creates a Paddle transaction for the verified active €5 monthly Exomem price with internal correlation metadata, atomically binds it to the owner and provider environment, and returns its hosted checkout URL

#### Scenario: Configured price is wrong

- **WHEN** the selected price is inactive, belongs to another product, is not EUR, is not monthly with frequency one, or is not exactly 500 cents
- **THEN** the deployment catalog gate fails without printing product, price, or credential identifiers
- **AND** no new Exomem checkout becomes available from that deployment

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
