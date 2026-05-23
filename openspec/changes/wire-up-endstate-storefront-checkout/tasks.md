## 1. Paddle client (frontend)

- [ ] 1.1 In `src/lib/paddle.ts`, replace the hard-coded
  `environment: 'production'` in `initializePaddle` with a read of
  `process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT`. Default `'production'`
  when unset; accept `'sandbox'` and `'production'` exactly (cast to
  the `@paddle/paddle-js` `Environments` union).
- [ ] 1.2 In `src/lib/paddle.ts`, add
  `openHostedBackupCheckout(cadence: 'monthly' | 'yearly')` to the
  `usePaddle()` return value:
  - Resolves the price ID from
    `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY` or
    `NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY` based on
    `cadence`.
  - Reuses `loadPaddle()` and the alert + console.error fallback
    pattern from `openEndstateCheckout`.
  - Calls `paddle.Checkout.open({ items: [{ priceId, quantity: 1 }] })`.
- [ ] 1.3 In `src/lib/paddle.ts`, add
  `openTransactionCheckout(transactionId: string)` to the
  `usePaddle()` return value:
  - Reuses `loadPaddle()`.
  - Calls `paddle.Checkout.open({ transactionId })`.
  - Same alert + console.error fallback on missing Paddle.

## 2. BuyButton (frontend)

- [ ] 2.1 In `src/app/endstate/BuyButton.tsx`, add an optional
  `action` prop typed as `(() => Promise<void> | void)`. Default to
  the existing `openEndstateCheckout` for backwards compat — the
  Supporter usage continues to work without changes.
- [ ] 2.2 Replace the inline `void openEndstateCheckout()` call in
  the button's `onClick` with `void action()`.

## 3. Storefront `_ptxn` resume

- [ ] 3.1 Create new file
  `src/app/endstate/PaddleTransactionOpener.tsx`:
  - `'use client'`, returns `null`.
  - On mount, read `_ptxn` from `window.location.search`.
  - If absent, no-op.
  - If present, await `usePaddle().openTransactionCheckout(txn)`
    once `ready === true`.
  - Guard with a `useRef<boolean>(false)` so React strict-mode does
    not double-invoke `Paddle.Checkout.open`.
- [ ] 3.2 In `src/app/endstate/page.tsx` `EndstatePage` default
  export, mount `<PaddleTransactionOpener />` at the top of the
  fragment (before the existing children) so the component runs
  regardless of where the user scrolls.

## 4. Hosted Backup pricing card (monthly + yearly)

- [ ] 4.1 In `src/app/endstate/page.tsx` `Pricing()`:
  - Add `const [hostedBackupCadence, setHostedBackupCadence] =
    useState<'monthly' | 'yearly'>('monthly');`.
  - Derive the Hosted Backup tier object inside `Pricing()` so its
    `price`, `cadence`, and `cta` react to the toggle, while keeping
    the existing `tiers.map(...)` loop shape intact.
  - Compute prices: monthly → `€4 /mo`; yearly → `€40 /yr`.
    Display a small "save 17%" hint adjacent to the yearly toggle
    option (the toggle itself styled to match the existing card —
    JetBrains Mono caption, copper border, similar to the existing
    `tier.badge`).
  - Drop the "Coming in v2" cadence subtitle.
- [ ] 4.2 Extend the tier render branch (lines 907–935) with a
  third branch for `cta.kind === 'paddle-hosted-backup'`:
  - Render `<BuyButton action={() => openHostedBackupCheckout(hostedBackupCadence)} className=... style=...>{cta.label}</BuyButton>`.
  - The CTA label updates with cadence: `Get Hosted Backup — €4/mo`
    or `Get Hosted Backup — €40/yr`.
  - Style matches the existing `<a>`/`<Link>` paths (transparent
    background, `1px solid ${c.border}` border, same radius,
    padding, and font).
- [ ] 4.3 Leave Free, Supporter, and Teams CTAs unchanged.

## 5. Type updates

- [ ] 5.1 In `src/app/endstate/page.tsx`, extend `PricingTier.cta`
  with an optional `kind?: 'paddle-hosted-backup'` discriminator.
  When set, the `href` is unused (the action is wired in the
  render branch).
- [ ] 5.2 In `src/lib/paddle.ts`, update `UsePaddleResult` to
  include the two new functions:
  ```ts
  openHostedBackupCheckout: (cadence: 'monthly' | 'yearly') => Promise<void>;
  openTransactionCheckout: (transactionId: string) => Promise<void>;
  ```

## 6. Validation

- [ ] 6.1 `npm run lint` is clean (no new warnings in modified
  files).
- [ ] 6.2 `npm run build` succeeds (Next.js production build,
  no TS errors).
- [ ] 6.3 `npm test` is green (no test changes required — the
  server-side checkout route tests in
  `src/app/api/billing/checkout/__tests__/route.test.ts` continue
  to pass; no frontend tests exist for the changed files and none
  are added in this PR).
- [ ] 6.4 `npm run openspec:validate` passes strict.

## 7. Manual verification

### 7.1 Local sanity

- [ ] 7.1.1 `npm run dev`; load `http://localhost:3000/endstate`:
  - Bare visit → page renders normally, Hosted Backup card shows
    a Monthly/Yearly toggle and an enabled CTA once Paddle.js
    loads.
  - Click the toggle → price (`€4 /mo` ↔ `€40 /yr`) and CTA label
    flip; cadence-aware CTA action swaps.
  - `http://localhost:3000/endstate?_ptxn=txn_test_123` → Paddle
    overlay attempts to open (Paddle.js shows its own
    "invalid transaction" error UI — that is the correct local
    signal).
- [ ] 7.1.2 Click Supporter "Support development" — confirm the
  existing lifetime checkout flow still opens correctly (no
  regression).

### 7.2 Cross-repo sandbox e2e (load-bearing)

Requires a substrate deploy with
`NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox` plus sandbox Paddle
credentials (either a Vercel preview from this branch or the
substrate staging env). Run the 9-step flow from the KB note via
the endstate-gui `livewire` skill:

1. Sign in / sign up a fresh test account on the substrate
   sandbox deploy.
2. Click **Subscribe** on the GUI's Backup pane.
3. GUI invokes `endstate backup subscribe` → engine calls
   substrate `/api/billing/checkout` → response is
   `…/endstate?_ptxn=<txn>`.
4. System browser opens the URL.
5. **Paddle overlay appears.** ← what this PR adds.
6. Pay with Paddle's sandbox test card
   (`4242 4242 4242 4242`).
7. `transaction.completed` webhook fires → substrate updates
   account entitlement.
8. Back in endstate-gui, `backup status` reflects
   `subscriptionStatus: 'active'`.
9. Push a backup; confirm the write gate is open.
10. From the marketing page (no `_ptxn`), click Hosted Backup
    with **Monthly** selected → pay with sandbox card → confirm
    webhook fires and entitlement flips. Repeat with **Yearly**
    selected (separate test account or after canceling the first
    sub).

## 8. Archive

- [ ] 8.1 After §6 and §7 pass and the PR merges + deploys, move
  this change directory to
  `openspec/changes/archive/<YYYY-MM-DD>-wire-up-endstate-storefront-checkout/`.
- [ ] 8.2 Update the KB launch-readiness note
  (`hosted-backup-checkout-remaining-tracks-2026-05-22`) — flip the
  red item to green.
- [ ] 8.3 Update the KB implementation-plan note
  (`substrate-endstate-paddle-checkout-wiring-implementation-plan.md`)
  to record that the yearly tier was pulled into scope on
  2026-05-24 and the deferral is rescinded.
