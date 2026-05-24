## ADDED Requirements

### Requirement: Storefront resumes engine-initiated checkout via `_ptxn`

The `/endstate` page SHALL detect the `_ptxn` query parameter on
page load and, once Paddle.js is ready, open the Paddle Checkout
overlay for that transaction by calling
`Paddle.Checkout.open({ transactionId: <ptxn> })`. The overlay
SHALL render in-page (no redirect). When the parameter is absent
the page SHALL render normally with no overlay. The handler SHALL
fire at most once per page load — React strict-mode double-mount
MUST NOT cause `Paddle.Checkout.open` to be called twice.

The handler relies on Paddle.js's own error UI for invalid or
expired transaction IDs; substrate SHALL NOT render its own error
state for this case.

#### Scenario: `/endstate?_ptxn=<valid-txn>` opens the overlay

- **GIVEN** a freshly minted Paddle transaction `txn_abc` and
  `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` configured
- **WHEN** the user loads `https://substratesystems.io/endstate?_ptxn=txn_abc`
- **THEN** Paddle.js initializes, the overlay opens, and
  `Paddle.Checkout.open` is called exactly once with
  `{ transactionId: "txn_abc" }`

#### Scenario: Bare `/endstate` visit does not open the overlay

- **GIVEN** no `_ptxn` query parameter
- **WHEN** the user loads `https://substratesystems.io/endstate`
- **THEN** the page renders normally and the Paddle overlay does
  not open

#### Scenario: Invalid `_ptxn` shows Paddle's own error UI

- **GIVEN** `_ptxn = "txn_does_not_exist"`
- **WHEN** the user loads `https://substratesystems.io/endstate?_ptxn=txn_does_not_exist`
- **THEN** `Paddle.Checkout.open` is called and Paddle's overlay
  surfaces its own error state
- **AND** substrate does not render any substrate-specific error
  banner for this case

### Requirement: Storefront initiates Hosted Backup checkout for monthly and yearly cadences

The `/endstate` page SHALL render the Hosted Backup pricing tier
with a user-selectable cadence (monthly or yearly). The tier's
displayed price (€4 /mo or €40 /yr), cadence label, and CTA label
SHALL update in response to the cadence toggle. Clicking the CTA
SHALL open the Paddle Checkout overlay for the price ID
corresponding to the selected cadence, calling
`Paddle.Checkout.open({ items: [{ priceId, quantity: 1 }] })`.

The Hosted Backup price IDs SHALL be supplied via the environment
variables `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY` and
`NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY`. When either is
unset, attempting to open that cadence SHALL surface an alert
(matching the existing Supporter-flow fallback) and log a
console.error; the button SHALL remain rendered but inert.

The marketing-page CTA SHALL NOT include `custom_data.user_id` in
the resulting Paddle transaction (the storefront has no
authenticated session). The webhook receiver already tolerates
this case via the
"Webhook resolves user_id via custom_data" requirement
(archived 2026-05-12).

The remaining pricing tiers (Free, Supporter, Teams) are NOT
affected by this requirement.

#### Scenario: Monthly cadence opens monthly-price checkout

- **GIVEN** `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY = "pri_monthly_x"`
- **AND** the toggle is in its default `monthly` position
- **WHEN** the user clicks the Hosted Backup CTA
- **THEN** `Paddle.Checkout.open` is called with
  `{ items: [{ priceId: "pri_monthly_x", quantity: 1 }] }`

#### Scenario: Yearly cadence opens yearly-price checkout

- **GIVEN** `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY = "pri_yearly_y"`
- **AND** the user flips the cadence toggle to `yearly`
- **WHEN** the user clicks the Hosted Backup CTA
- **THEN** `Paddle.Checkout.open` is called with
  `{ items: [{ priceId: "pri_yearly_y", quantity: 1 }] }`

#### Scenario: Cadence toggle updates the displayed price

- **GIVEN** the Hosted Backup card is visible with the toggle in
  `monthly`
- **THEN** the displayed price reads `€4` with a `/mo` suffix
- **WHEN** the user clicks the `yearly` option of the toggle
- **THEN** the displayed price reads `€40` with a `/yr` suffix
- **AND** a "save 17%" hint is visible next to the yearly option

#### Scenario: Missing env var disables the CTA gracefully

- **GIVEN** `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY` is
  unset
- **WHEN** the user clicks the Hosted Backup CTA with the toggle
  in `monthly`
- **THEN** an alert surfaces ("Checkout is unavailable right now.")
- **AND** `console.error` reports the missing env var
- **AND** `Paddle.Checkout.open` is NOT called

### Requirement: Client-side Paddle environment switch

The frontend Paddle client SHALL select its environment from the
`NEXT_PUBLIC_PADDLE_ENVIRONMENT` env var, mirroring the
server-side `PADDLE_ENVIRONMENT` switch. The value SHALL be
passed verbatim as the `environment` option to
`initializePaddle` from `@paddle/paddle-js`.

When `NEXT_PUBLIC_PADDLE_ENVIRONMENT` is unset, the frontend
SHALL default to `'production'`. (This default differs from the
server-side `PADDLE_ENVIRONMENT` which defaults to `'sandbox'`;
the frontend's default-to-production reflects that the
production substrate deploy is the dominant case. Sandbox preview
deploys MUST explicitly opt in with
`NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox`.)

#### Scenario: `NEXT_PUBLIC_PADDLE_ENVIRONMENT=production` initializes production Paddle

- **GIVEN** `NEXT_PUBLIC_PADDLE_ENVIRONMENT = "production"`
- **WHEN** the storefront initializes Paddle.js
- **THEN** `initializePaddle` is called with
  `{ environment: "production", token: <NEXT_PUBLIC_PADDLE_CLIENT_TOKEN> }`

#### Scenario: `NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox` initializes sandbox Paddle

- **GIVEN** `NEXT_PUBLIC_PADDLE_ENVIRONMENT = "sandbox"`
- **WHEN** the storefront initializes Paddle.js
- **THEN** `initializePaddle` is called with
  `{ environment: "sandbox", token: <NEXT_PUBLIC_PADDLE_CLIENT_TOKEN> }`
- **AND** a Paddle sandbox test card
  (e.g. `4242 4242 4242 4242`) successfully completes a sandbox
  checkout

#### Scenario: Unset `NEXT_PUBLIC_PADDLE_ENVIRONMENT` defaults to production

- **GIVEN** `NEXT_PUBLIC_PADDLE_ENVIRONMENT` is unset
- **WHEN** the storefront initializes Paddle.js
- **THEN** `initializePaddle` is called with
  `{ environment: "production", token: <NEXT_PUBLIC_PADDLE_CLIENT_TOKEN> }`
