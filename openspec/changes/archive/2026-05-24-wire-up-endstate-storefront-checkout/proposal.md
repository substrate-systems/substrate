## Why

The hosted-backup checkout pipeline shipped end-to-end except for the very last hop. After
`add-hosted-backup-storage-and-subscriptions`, `add-hosted-backup-test-bypass`,
`extend-hosted-backup-test-bypass-to-reads`, and
`wire-up-paddle-checkout-and-entitlement` (archived 2026-05-12), substrate already:

- Mints Paddle checkout transactions via `POST /api/billing/checkout`
  with the caller's `user_id` embedded in `custom_data`
  (`src/lib/hosted-backup/checkout.ts`, `src/app/api/billing/checkout/route.ts`).
- Routes server-side Paddle calls through `PADDLE_ENVIRONMENT` so
  sandbox/production can be flipped with a single env var.
- Receives `transaction.completed` and `subscription.*` webhooks and
  updates the per-user entitlement.

endstate-gui (v2.4.1) and the engine (v2.1.0) have shipped: clicking
**Subscribe** in the GUI runs `endstate backup subscribe`, which calls
the checkout endpoint above, receives
`https://substratesystems.io/endstate?_ptxn=<transaction_id>`, and
opens that URL in the user's system browser (Tauri `shell.open`, per
the engine-as-source-of-truth invariant —
`Knowledge Base/Notes/Patterns/engine-as-source-of-truth`).

But today's `/endstate` page (verified 2026-05-24 via WebFetch and the
codebase) drops the `_ptxn` query parameter on the floor:

1. **No Paddle.js initialization for the storefront.**
   `src/lib/paddle.ts` already loads `@paddle/paddle-js`, but only the
   Supporter (lifetime-license) flow uses it (`openEndstateCheckout`).
   It is not mounted on `/endstate` in any way that listens to
   `_ptxn`.
2. **No `_ptxn` handler.** Nothing reads
   `new URLSearchParams(window.location.search).get('_ptxn')` and
   nothing calls `paddle.Checkout.open({ transactionId })`.
3. **No way to initiate Hosted Backup checkout from the marketing
   page.** The Hosted Backup tier CTA in `src/app/endstate/page.tsx`
   is a `mailto:founder@substratesystems.io?subject=…waitlist…` link;
   the GUI is the *only* place that can start a real checkout, which
   defeats `/endstate`'s job as a self-serve storefront and blocks
   anyone landing there organically.
4. **Yearly cadence is shipped on Paddle but invisible to users.**
   The yearly Hosted Backup price (`pri_01ks0405v…`) was provisioned
   in Paddle but the marketing page exposes only "€4 /mo" with a
   "Coming in v2" cadence hint. Pulled into scope on user request
   2026-05-24 — the KB note's deferral
   ([[Knowledge Base/Notes/Research/Substrate/substrate-endstate-paddle-checkout-wiring-implementation-plan.md]])
   is superseded.
5. **No client-side Paddle environment switch.**
   `src/lib/paddle.ts:27` hard-codes `environment: 'production'`,
   which means even a sandbox-deploy of substrate would mint
   production Paddle overlays — making cross-repo e2e with sandbox
   cards impossible.

The KB note describes this as the *one* remaining substrate-side
blocker before Hosted Backup is shippable.

## What Changes

### 1. `_ptxn` resume on `/endstate`

A new client component
`src/app/endstate/PaddleTransactionOpener.tsx` SHALL read the
`_ptxn` query parameter from `window.location.search` on mount and,
once Paddle is ready, call `paddle.Checkout.open({ transactionId })`
exactly once per page load (guarded by a `useRef` for React
strict-mode double-mount). Mounted in the default `EndstatePage`
export.

### 2. Marketing-page Hosted Backup CTA — monthly and yearly

The Hosted Backup tier in `src/app/endstate/page.tsx` SHALL display a
**Monthly / Yearly toggle**. The price (`€4 /mo` ↔ `€40 /yr`),
cadence label, and the CTA action SHALL react to the toggle. A
"save 17%" hint SHALL appear next to the yearly option. The existing
`mailto:` waitlist CTA is replaced with a real Paddle button that
calls `openHostedBackupCheckout(cadence)`. The remaining tiers
(Free, Supporter, Teams) are NOT changed in this PR.

### 3. Generalize `src/lib/paddle.ts`

- Read `NEXT_PUBLIC_PADDLE_ENVIRONMENT` (optional, default
  `'production'` for production-deploy compatibility) and pass it to
  `initializePaddle`. Sandbox preview deploys SHALL set
  `NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox` to enable cross-repo e2e
  with sandbox cards.
- Add `openHostedBackupCheckout(cadence: 'monthly' | 'yearly')`
  reading `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY` and
  `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY` respectively.
- Add `openTransactionCheckout(transactionId: string)` calling
  `paddle.Checkout.open({ transactionId })`.

All three reuse the existing `loadPaddle()` singleton and the
`completionListeners` set.

### 4. Parameterize `BuyButton`

`src/app/endstate/BuyButton.tsx` SHALL accept an optional `action`
prop (defaulting to `openEndstateCheckout` for backwards compat) so
the same disabled-while-loading + completion-message shell drives
both Supporter and Hosted Backup CTAs.

### 5. Reuse

- `loadPaddle()` singleton, `completionListeners`, and the
  `usePaddle()` ready/error/completed state pattern in
  `src/lib/paddle.ts` — reused as-is.
- Existing pricing-tier card styling in
  `src/app/endstate/page.tsx:842–937` — reused; only a third render
  branch (paddle-action) is added.
- Server-side `/api/billing/checkout`, webhook receiver,
  `paddle-client.ts`, entitlement logic — not touched. Already live
  per `wire-up-paddle-checkout-and-entitlement` (archived
  2026-05-12).
- OpenSpec workflow, error envelope conventions, eslint/prettier
  config — unchanged.

### Acknowledged non-uniformity

The marketing-page CTA opens checkout WITHOUT `custom_data.user_id`
(no authenticated session on `/endstate`). The webhook receiver
must therefore continue to tolerate transactions without
`custom_data.user_id` — already handled by the
"Webhook resolves user_id via custom_data" requirement (archived
2026-05-12), which falls back to `findUserIdByPaddleCustomerId` and
ultimately to the `unknown_user` response. A marketing-page buyer
who has not yet linked a substrate account will need to do so
post-purchase via existing account-linking flows (out of scope for
this PR).

## Capabilities

### Modified Capabilities

`hosted-backup-subscriptions`: the storefront `/endstate` page is
added as a new initiation surface for Hosted Backup checkout, with
explicit support for resuming engine-initiated checkouts via the
`_ptxn` query parameter, initiating monthly or yearly checkouts from
the marketing page, and a client-side `NEXT_PUBLIC_PADDLE_ENVIRONMENT`
switch that mirrors the server-side `PADDLE_ENVIRONMENT`.

## Impact

- New files: `src/app/endstate/PaddleTransactionOpener.tsx`.
- Modified files: `src/lib/paddle.ts`,
  `src/app/endstate/BuyButton.tsx`, `src/app/endstate/page.tsx`.
- New env vars (frontend, all `NEXT_PUBLIC_*`):
  - `NEXT_PUBLIC_PADDLE_ENVIRONMENT` (optional, default
    `'production'`). Set to `'sandbox'` on preview/staging.
  - `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY` (required for
    the Hosted Backup monthly CTA to render enabled).
  - `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY` (required for
    the Hosted Backup yearly CTA to render enabled — set to the
    existing `pri_01ks0405v…` from the KB note).
- No DB migrations, no server-side route changes, no webhook
  changes.
- The Supporter (lifetime) flow continues to work unchanged.
- Cross-repo verification recipe is in tasks.md §7.
