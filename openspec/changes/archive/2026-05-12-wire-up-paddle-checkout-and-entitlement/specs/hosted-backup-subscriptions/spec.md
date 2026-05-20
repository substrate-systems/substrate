## MODIFIED Requirements

### Requirement: Subscription state machine

The system SHALL maintain one row per user in the `subscriptions` table with `status` constrained to `none`, `active`, `grace`, `paused`, or `cancelled`. Transitions are driven by Paddle webhook events. The `subscriptions.plan` column SHALL store the Paddle price identifier the user is subscribed to (or null when no row exists or the event did not carry a price).

#### Scenario: subscription.created transitions none → active

- **GIVEN** a user with `status = "none"` (or no subscription row)
- **WHEN** a `subscription.created` event whose `data.custom_data.user_id` identifies that user is processed
- **THEN** the user's `subscriptions.status` is `active` AND `subscriptions.plan` matches `data.items[0].price.id` from the event AND `paddle_subscription_id` and `paddle_customer_id` are populated

#### Scenario: subscription.past_due transitions active → grace

- **GIVEN** a user with `status = "active"`
- **WHEN** a `subscription.past_due` event is processed
- **THEN** the user's `subscriptions.status` is `grace` AND `grace_started_at` is set

#### Scenario: subscription.activated transitions grace → active

- **GIVEN** a user with `status = "grace"`
- **WHEN** a `subscription.activated` event is processed
- **THEN** the user's `subscriptions.status` is `active` AND `grace_started_at` is cleared

#### Scenario: subscription.canceled transitions active → cancelled

- **GIVEN** a user with `status = "active"`
- **WHEN** a `subscription.canceled` event (Paddle's spelling) is processed
- **THEN** the user's `subscriptions.status` is `cancelled` (internal spelling, two l's) AND `cancel_started_at` is set

#### Scenario: subscription.paused transitions active → paused

- **GIVEN** a user with `status = "active"`
- **WHEN** a `subscription.paused` event is processed
- **THEN** the user's `subscriptions.status` is `paused`

#### Scenario: subscription.resumed transitions paused → active

- **GIVEN** a user with `status = "paused"`
- **WHEN** a `subscription.resumed` event is processed
- **THEN** the user's `subscriptions.status` is `active`

### Requirement: Write/read gating per state

The system SHALL gate write paths (`POST /api/backups`, `POST .../versions`) on `status = "active"`. Read paths (`GET .../versions`, `POST .../download-urls`, `DELETE .../versions/:versionId`, `DELETE /api/backups/:backupId`) SHALL allow `active`, `grace`, `paused`, and `cancelled`. All routes SHALL block `status = "none"`. Effective status SHALL apply the 14-day grace cutoff defined in *Time-bounded grace window*; that is, a user whose stored status is `grace` and whose `grace_started_at` is older than 14 days is treated as `cancelled` for gating purposes (writes blocked, reads still allowed).

#### Scenario: Write blocked in grace

- **WHEN** a user with `status = "grace"` (within 14 days) calls `POST /api/backups/:backupId/versions`
- **THEN** the response is HTTP 402 and `error.code` is `SUBSCRIPTION_REQUIRED`

#### Scenario: Read allowed in cancelled

- **WHEN** a user with `status = "cancelled"` calls `POST /api/backups/:backupId/versions/:versionId/download-urls`
- **THEN** the response is HTTP 200 with download URLs

#### Scenario: All paths blocked in none

- **WHEN** a user with `status = "none"` calls any `/api/backups/*` route
- **THEN** the response is HTTP 402 and `error.code` is `SUBSCRIPTION_REQUIRED`

#### Scenario: Write blocked in paused, read allowed

- **GIVEN** a user with `subscriptions.status = "paused"`
- **WHEN** the user calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`
- **WHEN** the same user calls `GET /api/backups`
- **THEN** the response is HTTP 200

#### Scenario: Grace beyond 14 days is treated as cancelled

- **GIVEN** a user with stored `status = "grace"` and `grace_started_at = now - 15 days`
- **WHEN** the user calls `POST /api/backups`
- **THEN** the response is HTTP 402 (effective status `cancelled`)
- **WHEN** the same user calls `GET /api/backups`
- **THEN** the response is HTTP 200 (reads still allowed for effective `cancelled`)

## ADDED Requirements

### Requirement: Webhook resolves user_id via custom_data

`POST /api/webhooks/paddle` SHALL resolve the internal `user_id` for a subscription event by trying, in order:

1. `event.data.custom_data.user_id` (Paddle Billing API)
2. `event.data.passthrough.user_id` if `passthrough` is an object, or `JSON.parse(passthrough).user_id` if it is a string (legacy)
3. `findUserIdByPaddleCustomerId(event.data.customer_id)` (returning subscriber whose row was created by an earlier event)

Only when all three sources fail SHALL the handler return its existing `unknown_user` response (HTTP 200, `unknown_user: true`).

#### Scenario: First-time subscription.created with custom_data is bound to the right user

- **GIVEN** an authenticated user `u-1` with no existing `subscriptions` row
- **WHEN** a `subscription.created` event arrives with `event.data.custom_data.user_id = "u-1"` and `event.data.customer_id = "cus_new"`
- **THEN** a new `subscriptions` row is upserted for `u-1` with `status = "active"`, `paddle_customer_id = "cus_new"`, `paddle_subscription_id = event.data.id`, and `plan` from `event.data.items[0].price.id`
- **AND** the webhook response is HTTP 200 with `userId: "u-1"`

#### Scenario: Subsequent event without custom_data falls back to paddle_customer_id

- **GIVEN** an existing `subscriptions` row for `u-1` with `paddle_customer_id = "cus_new"`
- **WHEN** a `subscription.past_due` event arrives with `event.data.customer_id = "cus_new"` and no `custom_data`
- **THEN** the existing row is updated to `status = "grace"`

#### Scenario: Event with neither custom_data nor a known customer is tolerated

- **WHEN** a well-signed `subscription.created` event arrives with no `custom_data` and a `customer_id` that does not match any existing row
- **THEN** the response is HTTP 200 with `unknown_user: true` and no row is created

### Requirement: Authenticated checkout URL builder

`POST /api/billing/checkout` SHALL be an authenticated endpoint that returns a Paddle checkout URL for the hosted-backup subscription, with the authenticated user's `user_id` embedded in `custom_data` so the eventual webhook can correlate the subscription back to the user.

The endpoint SHALL use `requireAuth` (NOT `requireWriteAccess` or `requireReadAccess`) so that a user without an active subscription can still start checkout.

The endpoint SHALL read the price ID from `process.env.PADDLE_PRICE_ID_HOSTED_BACKUP`. If unset, the response SHALL be HTTP 500 with `error.code = "SERVER_MISCONFIGURED"`.

The endpoint SHALL call Paddle's `POST /transactions` API at the base URL returned by `paddleApiBaseUrl()`, with body:

```
{
  items: [{ price_id: <env price id>, quantity: 1 }],
  custom_data: { user_id: <authenticated user_id> },
  checkout: { url: <PADDLE_CHECKOUT_SUCCESS_URL or undefined> }
}
```

The endpoint SHALL return `{ checkoutUrl, transactionId }` and the `X-Endstate-API-Version` header. On non-2xx from Paddle, the response SHALL be HTTP 502 with `error.code = "PADDLE_API_ERROR"`.

#### Scenario: Unauthenticated request returns 401

- **WHEN** `POST /api/billing/checkout` is called without a Bearer token
- **THEN** the response is HTTP 401 `UNAUTHENTICATED`

#### Scenario: Missing price ID returns SERVER_MISCONFIGURED

- **GIVEN** `process.env.PADDLE_PRICE_ID_HOSTED_BACKUP` is unset
- **WHEN** an authenticated user calls `POST /api/billing/checkout`
- **THEN** the response is HTTP 500 `SERVER_MISCONFIGURED`

#### Scenario: Happy path embeds user_id in custom_data

- **GIVEN** an authenticated user `u-1`
- **AND** `process.env.PADDLE_PRICE_ID_HOSTED_BACKUP = "pri_test_123"`
- **WHEN** `u-1` calls `POST /api/billing/checkout`
- **THEN** the outbound Paddle request body has `custom_data.user_id = "u-1"` and `items[0].price_id = "pri_test_123"`
- **AND** the response is HTTP 200 with `{ checkoutUrl, transactionId }` populated from the Paddle response

### Requirement: Paddle environment switch

A single environment variable `PADDLE_ENVIRONMENT` SHALL select the Paddle API base URL used by all server-side Paddle calls. When `PADDLE_ENVIRONMENT === "production"` the base URL is `https://api.paddle.com`; otherwise (including unset) it is `https://sandbox-api.paddle.com`. The default-to-sandbox stance is deliberate: production must be explicitly opted in.

All server-side Paddle calls (`createCheckoutTransaction`, `cancelPaddleSubscription`, `fetchPaddleCustomerEmail`) SHALL route through `paddleApiBaseUrl()` from `src/lib/hosted-backup/paddle-client.ts`.

#### Scenario: PADDLE_ENVIRONMENT=production selects production base URL

- **GIVEN** `process.env.PADDLE_ENVIRONMENT = "production"`
- **WHEN** any server-side Paddle call is made
- **THEN** the request URL is prefixed with `https://api.paddle.com`

#### Scenario: PADDLE_ENVIRONMENT=sandbox selects sandbox base URL

- **GIVEN** `process.env.PADDLE_ENVIRONMENT = "sandbox"`
- **WHEN** any server-side Paddle call is made
- **THEN** the request URL is prefixed with `https://sandbox-api.paddle.com`

#### Scenario: PADDLE_ENVIRONMENT unset defaults to sandbox

- **GIVEN** `process.env.PADDLE_ENVIRONMENT` is unset
- **WHEN** any server-side Paddle call is made
- **THEN** the request URL is prefixed with `https://sandbox-api.paddle.com`

### Requirement: Time-bounded grace window

`getSubscriptionStatus(userId)` SHALL return `'cancelled'` when the stored row has `status = 'grace'` and `grace_started_at < now() - INTERVAL '14 days'`. The stored row MUST NOT be mutated by the read — the cutoff is a read-side effective-status gate so a late `subscription.activated` from Paddle can still recover the user without an additional state-machine path.

#### Scenario: Grace within 14 days returns grace

- **GIVEN** a user with stored `status = "grace"` and `grace_started_at = now - 10 days`
- **WHEN** `getSubscriptionStatus` is called
- **THEN** the return value is `'grace'`

#### Scenario: Grace older than 14 days returns cancelled

- **GIVEN** a user with stored `status = "grace"` and `grace_started_at = now - 15 days`
- **WHEN** `getSubscriptionStatus` is called
- **THEN** the return value is `'cancelled'`
- **AND** the stored row is unchanged

#### Scenario: Late activation after stale grace recovers the user

- **GIVEN** a user with stored `status = "grace"` and `grace_started_at = now - 20 days`
- **WHEN** a `subscription.activated` webhook event arrives for that user
- **THEN** `upsertSubscription` writes `status = "active"` with `grace_started_at = null`
- **AND** subsequent `getSubscriptionStatus` returns `'active'`

### Requirement: Entitlement endpoint exposes plan and Paddle IDs

`GET /api/account/me` SHALL return the following JSON shape:

```
{
  userId: string,
  email: string,
  createdAt: string,                          // ISO-8601
  subscriptionStatus: "none"|"active"|"grace"|"paused"|"cancelled",
  plan: string | null,
  currentPeriodEnd: string | null,            // ISO-8601 or null
  gracePeriodEndsAt: string | null,           // ISO-8601 or null
  paddleSubscriptionId: string | null,
  paddleCustomerId: string | null
}
```

`subscriptionStatus` is the *effective* status — that is, the value returned by `getSubscriptionStatus` (post 14-day grace cutoff). `gracePeriodEndsAt` is non-null only when the **stored** status is `"grace"`; it is `grace_started_at + 14 days`. The fields `plan`, `currentPeriodEnd`, `paddleSubscriptionId`, `paddleCustomerId` are null when no `subscriptions` row exists.

#### Scenario: No subscription row returns null fields

- **GIVEN** an authenticated user with no `subscriptions` row
- **WHEN** the user calls `GET /api/account/me`
- **THEN** the response includes `subscriptionStatus: "none"` and all subscription-detail fields are `null`

#### Scenario: Active subscription returns plan and period end

- **GIVEN** an authenticated user with `subscriptions.status = "active"`, `plan = "pri_x"`, `current_period_end = "2026-06-01T00:00:00Z"`
- **WHEN** the user calls `GET /api/account/me`
- **THEN** the response includes `subscriptionStatus: "active"`, `plan: "pri_x"`, `currentPeriodEnd: "2026-06-01T00:00:00Z"`, `gracePeriodEndsAt: null`, and non-null `paddleSubscriptionId` and `paddleCustomerId`

#### Scenario: Grace subscription returns gracePeriodEndsAt

- **GIVEN** an authenticated user with `subscriptions.status = "grace"`, `grace_started_at = "2026-05-05T00:00:00Z"`
- **WHEN** the user calls `GET /api/account/me`
- **THEN** the response includes `gracePeriodEndsAt: "2026-05-19T00:00:00Z"`

#### Scenario: Stale grace surfaces effective cancelled but keeps gracePeriodEndsAt populated

- **GIVEN** an authenticated user with stored `subscriptions.status = "grace"` and `grace_started_at = now - 15 days`
- **WHEN** the user calls `GET /api/account/me`
- **THEN** `subscriptionStatus` is `"cancelled"` (effective)
- **AND** `gracePeriodEndsAt` is the original `grace_started_at + 14 days` (operators can see why the user is gated)
