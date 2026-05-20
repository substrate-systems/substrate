## Why

The hosted-backup subscription plumbing landed in earlier changes
(`add-hosted-backup-storage-and-subscriptions`,
`add-hosted-backup-test-bypass`,
`extend-hosted-backup-test-bypass-to-reads`) — table, idempotency,
state machine, signature verification, gates, JWT hint — but the GUI
cannot actually drive a subscription end-to-end against this backend
today. Three gaps make the existing wiring unusable for a real
user-initiated checkout:

1. **No user_id correlation on first event.** `applyPaddleEvent` resolves
   `userId` only via `findUserIdByPaddleCustomerId`, which queries the
   same `subscriptions` table the event is supposed to populate. The
   first `subscription.created` for a user therefore returns
   `unknown_user` (`src/lib/hosted-backup/subscriptions.ts:68-71`)
   because the row keyed by `paddle_customer_id` does not exist yet.
2. **No checkout URL builder.** There is no authenticated endpoint the
   GUI can call to ask for a Paddle checkout URL with the caller's
   `user_id` embedded as `custom_data`. Only a client-side Paddle.js
   modal exists in `src/lib/paddle.ts`, which is for the standalone
   lifetime-license product, not the hosted-backup subscription, and
   has no way to pass `user_id` through the eventual webhook.
3. **No sandbox/production switch.** The Paddle API base URL is hard
   coded to `https://api.paddle.com` in two places
   (`src/lib/hosted-backup/subscriptions.ts:181`,
   `src/lib/license/paddle.ts:86`). There is no way to point at
   `sandbox-api.paddle.com` without code changes.

Three smaller gaps follow from the contract this change is targeting:

4. **No `plan` column.** The product owner needs to know which plan a
   subscriber is on for support and debugging. The current schema lacks
   it.
5. **No `paused`/`resumed` handling.** Paddle emits these on the
   Billing API but `HANDLED_EVENTS` is `{created, activated, past_due,
   canceled, updated}`.
6. **Grace is open-ended.** The contract requires that `past_due` keep
   a user entitled for 14 days, then cuts them off. Today `status =
   "grace"` persists indefinitely until Paddle sends another event.
7. **`GET /api/account/me` is sparse.** It returns `subscriptionStatus`
   only — no `plan`, `currentPeriodEnd`, no Paddle IDs. The GUI cannot
   show "your plan renews on Jun 1" or surface a support ID without
   round-tripping to Paddle directly.

## What Changes

### 1. user_id correlation via `custom_data`

`applyPaddleEvent` SHALL prefer `event.data.custom_data.user_id` (legacy
fallback: `event.data.passthrough.user_id` and string-form
`event.data.passthrough` parsed as JSON) when present. Only events that
lack `custom_data` (e.g. a Paddle-dashboard-initiated change to an
existing subscription) fall back to the `findUserIdByPaddleCustomerId`
lookup. When both fail, the existing `unknown_user` path is preserved.

### 2. Server-side checkout URL builder

New module `src/lib/hosted-backup/checkout.ts` exports
`createCheckoutTransaction({ userId, priceId })` which calls Paddle's
`POST /transactions` with `custom_data: { user_id }` and a single line
item (the hosted-backup price). Returns `{ checkoutUrl, transactionId }`.

New route `POST /api/billing/checkout` is authenticated via
`requireAuth` (NOT `requireWriteAccess` — a user with no subscription
must be able to start checkout). It reads
`PADDLE_PRICE_ID_HOSTED_BACKUP` from env (returns `SERVER_MISCONFIGURED`
if unset), calls `createCheckoutTransaction`, and returns
`{ checkoutUrl, transactionId }` with `X-Endstate-API-Version` header.

### 3. Single env-var sandbox/prod switch

New module `src/lib/hosted-backup/paddle-client.ts` exports
`paddleApiBaseUrl()`, returning `https://sandbox-api.paddle.com` when
`PADDLE_ENVIRONMENT === 'production'` is FALSE (so the default is
sandbox — production must be explicitly opted in), and
`https://api.paddle.com` when it is `production`. Both existing call
sites (`subscriptions.ts:181` cancel, `license/paddle.ts:86` customer
fetch) plus the new checkout module route through this helper.

### 4. `plan` column

Migration `0012_subscriptions_plan.sql` adds a nullable `plan text`
column. `upsertSubscription` accepts an optional `plan` argument and
writes it. The state machine extracts the plan identifier from the
event (`data.items[0].price.id` for Billing API events) and passes it
through.

### 5. `paused` / `resumed`

Migration `0013_subscriptions_status_paused.sql` swaps the
`status` CHECK constraint to include `'paused'`. `HANDLED_EVENTS` adds
`subscription.paused` and `subscription.resumed`. `mapEventToStatus`:
- `subscription.paused` → `status = 'paused'`
- `subscription.resumed` → `status = 'active'`
- `subscription.updated` with paddle status `'paused'` → `status = 'paused'`

`requireWriteAccess` blocks `'paused'`; `requireReadAccess` allows it
(parallel to `'cancelled'`).

### 6. 14-day grace cutoff (read-time)

`getSubscriptionStatus` SHALL return `'cancelled'` when the stored row
has `status = 'grace'` and `grace_started_at` is older than
`now() - INTERVAL '14 days'`. The DB row is NOT mutated — a late
`subscription.activated` from Paddle must still be able to recover the
user. The cutoff is a read-side effective-status gate. This change
flows automatically into `requireWriteAccess` and `requireReadAccess`
which already call `getSubscriptionStatus`.

### 7. Richer entitlement on `GET /api/account/me`

The route SHALL return:

```
{
  userId, email, createdAt,
  subscriptionStatus,        // effective, post-cutoff
  plan,                      // from the subscriptions row, null if no row
  currentPeriodEnd,          // ISO-8601 or null
  gracePeriodEndsAt,         // grace_started_at + 14 days, only when stored status = grace
  paddleSubscriptionId,      // null if no row
  paddleCustomerId           // null if no row
}
```

New helper `getSubscriptionEntitlement(userId)` in `db.ts` returns the
full row so the route can compute `gracePeriodEndsAt` and apply the
cutoff in a single read.

### 8. Reuse

- Auth: existing `requireAuth` (`auth-middleware.ts:13`).
- DB: existing Neon serverless `sql\`...\`` template-literal pattern.
- Migrations: existing numbered-`.sql` convention; `npm run migrate`.
- Signature verification: existing `verifyPaddleSignature`.
- Test-email bypass: untouched. The 14-day grace cutoff applies BEFORE
  the bypass check, so a bypassed account never observes the
  cutoff — bypass continues to fully skip the subscription read.
- Error envelope, API version header, OpenSpec workflow per repo
  convention.

## Capabilities

### Modified Capabilities

`hosted-backup-subscriptions`: status enum widens to include `paused`;
gating extends to `paused` (read-allowed, write-blocked); webhook user
correlation prefers `custom_data.user_id` with `paddle_customer_id`
fallback; grace is bounded to 14 days at read time; webhook handles
`subscription.paused` and `subscription.resumed`; `GET /api/account/me`
exposes the richer entitlement shape; a new authenticated
`POST /api/billing/checkout` endpoint mints Paddle transactions; the
Paddle API base URL is selected from a single `PADDLE_ENVIRONMENT`
env var.

## Impact

- Two new migrations (`0012`, `0013`). Must run before deploy per
  `docs/runbooks/production-keys-and-storage.md`.
- New files: `src/lib/hosted-backup/paddle-client.ts`,
  `src/lib/hosted-backup/checkout.ts`,
  `src/app/api/billing/checkout/route.ts`.
- Modified files: `src/lib/hosted-backup/subscriptions.ts`,
  `src/lib/hosted-backup/db.ts`, `src/lib/hosted-backup/types.ts`,
  `src/lib/hosted-backup/auth-middleware.ts`,
  `src/lib/license/paddle.ts`, `src/app/api/account/me/route.ts`.
- New env vars: `PADDLE_ENVIRONMENT` (default `sandbox`),
  `PADDLE_PRICE_ID_HOSTED_BACKUP`. Optional:
  `PADDLE_CHECKOUT_SUCCESS_URL`, `PADDLE_CHECKOUT_CANCEL_URL`.
- New tests; existing tests continue to pass.
- `AccountMeResponse` type shape changes (added fields). The change is
  additive for older GUI clients but new fields are non-optional in TS;
  no backwards-compat shim is needed because the GUI ships in lockstep
  with this backend.
- Verification recipe is documented in tasks.md §6.
