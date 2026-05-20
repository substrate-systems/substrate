## 1. Schema

- [ ] 1.1 Add `migrations/0012_subscriptions_plan.sql`:
  `ALTER TABLE subscriptions ADD COLUMN plan text;`
- [ ] 1.2 Add `migrations/0013_subscriptions_status_paused.sql`:
  drop the existing status CHECK constraint and re-add it with `'paused'`
  in the value set. Migration name reflects intent.

## 2. Paddle client (env switch)

- [ ] 2.1 Create `src/lib/hosted-backup/paddle-client.ts`:
  - `paddleApiBaseUrl(): string` — returns
    `https://api.paddle.com` when `process.env.PADDLE_ENVIRONMENT === 'production'`,
    `https://sandbox-api.paddle.com` otherwise (unset = sandbox).
  - `paddleFetch(path, init)` — convenience wrapper that prefixes the
    base URL and attaches `Authorization: Bearer ${PADDLE_API_KEY}`.
    Throws on missing API key.
- [ ] 2.2 Refactor `src/lib/hosted-backup/subscriptions.ts`
  `cancelPaddleSubscription` to call `paddleFetch`.
- [ ] 2.3 Refactor `src/lib/license/paddle.ts`
  `fetchPaddleCustomerEmail` to call `paddleFetch`.

## 3. Checkout

- [ ] 3.1 Create `src/lib/hosted-backup/checkout.ts`:
  `createCheckoutTransaction({ userId, priceId, successUrl?, cancelUrl? })`:
  - POSTs to `${paddleApiBaseUrl()}/transactions`
  - Body: `{ items: [{ price_id, quantity: 1 }], custom_data: { user_id }, checkout?: { url } }`
  - Returns `{ checkoutUrl, transactionId }`; throws on non-2xx with
    the Paddle error body in the message.
- [ ] 3.2 Create `src/app/api/billing/checkout/route.ts`:
  - `POST` handler, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
  - Calls `requireAuth(req)` (NOT `requireWriteAccess` — a paywalled
    user needs to be able to start checkout).
  - Reads `PADDLE_PRICE_ID_HOSTED_BACKUP` from env. If unset, return a
    `SERVER_MISCONFIGURED` error with status 500 via `errorResponse`.
  - Calls `createCheckoutTransaction({ userId, priceId, successUrl, cancelUrl })`
    where success/cancel URLs come from `PADDLE_CHECKOUT_SUCCESS_URL`
    and `PADDLE_CHECKOUT_CANCEL_URL` (optional).
  - Returns `jsonWithApiVersion({ checkoutUrl, transactionId }, 200)`.
  - Errors from Paddle surface as a `PADDLE_API_ERROR` 502 envelope.

## 4. State machine

- [ ] 4.1 In `src/lib/hosted-backup/subscriptions.ts`:
  - Extend `PaddleSubscriptionEventData` with
    `custom_data?: { user_id?: string }`, `passthrough?: string | { user_id?: string }`,
    `items?: Array<{ price?: { id?: string } }>`.
  - Add `subscription.paused` and `subscription.resumed` to
    `HANDLED_EVENTS`.
  - In `mapEventToStatus`:
    - `subscription.paused` → `status = 'paused'`, all timestamps null
    - `subscription.resumed` → `status = 'active'`, all timestamps null
    - `subscription.updated` with paddle `status = 'paused'` → `status = 'paused'`
  - In `applyPaddleEvent`:
    - Extract `userId` by trying `custom_data.user_id`, then
      `passthrough` (parse JSON string if string, otherwise object),
      then `findUserIdByPaddleCustomerId`.
    - Extract `plan` from `data.items[0]?.price?.id` (best effort, may
      be null).
    - Pass `plan` through to `upsertSubscription`.

## 5. DB and middleware

- [ ] 5.1 In `src/lib/hosted-backup/db.ts`:
  - `SubscriptionStatus` import already covers `paused` once
    `types.ts` is updated.
  - Add `plan: string | null` to `SubscriptionRow`.
  - Extend `upsertSubscription` to accept `plan?: string | null` and
    write/overwrite it.
  - Modify `getSubscriptionStatus` to read `status, grace_started_at`
    and return `'cancelled'` if `status === 'grace'` and
    `grace_started_at < now - 14 days`. Use a single SQL query (no
    second round-trip).
  - Add `getSubscriptionEntitlement(userId)` returning a struct with
    `{ effectiveStatus, storedStatus, plan, currentPeriodEnd,
       gracePeriodEndsAt, paddleSubscriptionId, paddleCustomerId,
       updatedAt }`.
- [ ] 5.2 In `src/lib/hosted-backup/types.ts`:
  - Extend `SubscriptionStatus` to include `'paused'`.
  - Extend `AccountMeResponse` with the seven new fields (see
    proposal §7).
- [ ] 5.3 In `src/lib/hosted-backup/auth-middleware.ts`:
  - `requireWriteAccess` already rejects anything not `'active'`; no
    code change beyond TS type widening.
  - `requireReadAccess` currently rejects `'none'` only; this
    correctly allows `'paused'` once the type accepts it. Update JSDoc
    to mention `paused` is read-only.

## 6. account/me

- [ ] 6.1 In `src/app/api/account/me/route.ts`:
  - Replace the `getSubscriptionStatus` call with
    `getSubscriptionEntitlement`.
  - Return the rich `AccountMeResponse` shape.

## 7. Tests

- [ ] 7.1 Extend `src/lib/hosted-backup/__tests__/subscriptions.test.ts`:
  - `subscription.paused` → status `'paused'`
  - `subscription.resumed` → status `'active'`
  - `subscription.updated` with paddle `'paused'` → status `'paused'`
- [ ] 7.2 New `src/lib/hosted-backup/__tests__/paddle-client.test.ts`:
  - `PADDLE_ENVIRONMENT='production'` → `https://api.paddle.com`
  - `PADDLE_ENVIRONMENT='sandbox'` → `https://sandbox-api.paddle.com`
  - unset → `https://sandbox-api.paddle.com`
- [ ] 7.3 Extend `src/lib/hosted-backup/__tests__/paddle-webhook.test.ts`:
  - First-time `subscription.created` with
    `custom_data.user_id = 'u-new'` and no pre-existing row → upsert
    is called with `userId = 'u-new'`, NOT `unknown_user`.
  - `subscription.paused` for a known user → upsert is called with
    `status = 'paused'`.
- [ ] 7.4 New `src/app/api/billing/checkout/__tests__/route.test.ts`:
  - 401 without bearer token.
  - 500 `SERVER_MISCONFIGURED` when `PADDLE_PRICE_ID_HOSTED_BACKUP`
    unset.
  - Happy path: Paddle fetch is intercepted (via mock of
    `paddle-client`), returns a fake transaction; response is
    `{ checkoutUrl, transactionId }`; outbound body includes
    `custom_data.user_id`.
- [ ] 7.5 Extend `src/lib/hosted-backup/__tests__/subscription-gating.test.ts`:
  - `requireWriteAccess` blocks `'paused'`.
  - `requireReadAccess` allows `'paused'`.
  - Grace cutoff cases are covered via `getSubscriptionStatus` mock
    returning `'cancelled'` when the cutoff has hit (the cutoff itself
    is unit-tested in the db.ts tests).
- [ ] 7.6 New unit coverage in `subscriptions.test.ts` for plan
  extraction: an event with `data.items[0].price.id = 'pri_x'` results
  in the upsert call receiving `plan: 'pri_x'`.
- [ ] 7.7 Grace cutoff coverage in a new
  `src/lib/hosted-backup/__tests__/grace-cutoff.test.ts` that exercises
  the SQL via a mocked sql template, asserting `'cancelled'` is
  returned when `grace_started_at` is older than 14 days.

## 8. Validation

- [ ] 8.1 `npm run openspec:validate` passes strict.
- [ ] 8.2 `npm test` is green.
- [ ] 8.3 Manual verification (Paddle sandbox):
  1. `npm run migrate` (apply 0012 + 0013 on a Neon branch).
  2. Sign up a test user.
  3. `POST /api/billing/checkout` returns a
     `sandbox-checkout.paddle.com` URL; the request body carries the
     user_id in `custom_data`.
  4. Complete checkout in the URL; webhook arrives at
     `/api/webhooks/paddle`; row appears in `subscriptions` with
     `status='active'`, `plan` set, `current_period_end` populated.
  5. `GET /api/account/me` returns the full entitlement shape.
  6. Trigger past_due in Paddle; row becomes `grace`.
     Manually `UPDATE subscriptions SET grace_started_at = now() -
     INTERVAL '15 days'` in the Neon branch and assert
     `subscriptionStatus = 'cancelled'` is returned by
     `GET /api/account/me`.
  7. Switch `PADDLE_ENVIRONMENT=production` on a throwaway preview
     branch and confirm the outbound Paddle base URL flips.

## 9. Archive

- [ ] 9.1 After §8 passes, move this change directory to
  `openspec/changes/archive/2026-05-12-wire-up-paddle-checkout-and-entitlement/`
  per repo convention.
