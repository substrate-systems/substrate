## 1. Migration

- [ ] 1.1 `migrations/0014_claim_tokens.sql`:
  - `token_hash bytea PRIMARY KEY`
  - `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `email citext NOT NULL`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `expires_at timestamptz NOT NULL`
  - `consumed_at timestamptz`
  - `resend_count smallint NOT NULL DEFAULT 0`
  - `last_sent_at timestamptz NOT NULL DEFAULT now()`
  - `founder_alerted_at timestamptz`
  - Partial index on `user_id` where `consumed_at IS NULL`.

## 2. Claim-token primitives

- [ ] 2.1 `src/lib/hosted-backup/claim-tokens.ts`:
  - `mintClaimToken({ userId, email })` — generate 32 random bytes,
    sha-256 them, insert row with `expires_at = now() + 30d`,
    return `{ token, tokenHash }`.
  - `verifyClaimToken(token)` — sha-256 lookup, returns row or null
    when missing/expired/consumed.
  - `consumeClaimToken(token)` — atomic update setting `consumed_at`
    only if still null; throws on race or missing.
  - `findResendableClaims({ now })` — SELECT for cron.
  - `findFounderAlertableClaims({ now })` — SELECT for the 14d digest.
  - `markFounderAlerted(tokenHashes)` — UPDATE setter.
  - Tests: `__tests__/claim-tokens.test.ts` covers mint→verify→consume,
    expiry, double-consume race, hash-storage invariant.

## 3. DB helpers

- [ ] 3.1 In `src/lib/hosted-backup/db.ts`:
  - `ensurePreAccount(email)` — `INSERT ... ON CONFLICT (email) DO
    NOTHING` against `users`, then `SELECT id FROM users WHERE email = $1`.
    Returns `{ userId, isNew }`.
  - `userHasAuthCredentials(userId)` — `SELECT 1 FROM auth_credentials
    WHERE user_id = $1`. Returns boolean.
  - `attachAuthCredentialsToUser({ userId, … })` — wraps the existing
    `insertAuthCredentials` so callers don't have to know the
    distinction; throws if credentials already exist for the user.

## 4. Email templates

- [ ] 4.1 `src/lib/email-templates/claim.ts`:
  - `renderClaimEmail({ email, token, code })` →
    `{ subject, htmlContent, textContent }`. Subject:
    "Claim your Endstate Hosted Backup subscription". Body: greeting,
    claim URL (`https://substratesystems.io/endstate/claim/<token>`),
    plaintext code, Endstate download link, support footer.
  - `renderFyiEmail({ email, plan, currentPeriodEnd })` → FYI to
    existing users. Subject: "Hosted Backup added to your Endstate
    account". Body: confirmation, renewal date, contact-on-mistake
    footer.
  - `renderResendClaimEmail({ … })` — same as `renderClaimEmail` with
    a "still need to claim?" preamble.
  - `renderFounderDigest({ pendingClaims })` — list of {email,
    createdAt, paddleCustomerId} rows for manual review.
  - All templates: HTML uses inline styles, text is plaintext-first
    and complete on its own. No external assets.

## 5. Webhook orchestration

- [ ] 5.1 In `src/lib/hosted-backup/subscriptions.ts`:
  - Extend `applyPaddleEvent(event)` signature to
    `applyPaddleEvent(event, opts?: { resolveByEmail?: (customerId:
    string) => Promise<{ userId: string; isPreAccount: boolean } |
    null> })`.
  - When standard resolution (`extractUserIdFromEvent` +
    `findUserIdByPaddleCustomerId`) returns null AND
    `event.event_type === 'subscription.created'` AND `opts?.resolveByEmail`
    is provided, call `opts.resolveByEmail(customerId)`. Use the
    returned `userId` for the upsert; thread `isPreAccount` into the
    `ApplyResult` as an optional flag.
  - `ApplyResult` `'applied'` variant gains an optional
    `preAccountFlow?: { isPreAccount: boolean }` field.
- [ ] 5.2 In `src/app/api/webhooks/paddle/route.ts`:
  - Build a `resolveByEmail` closure that calls
    `fetchPaddleCustomerEmail(customerId)` (try/catch — on Paddle API
    failure return null, log warn, fall through to `unknown_user`).
  - Pass it to `applyPaddleEvent(event, { resolveByEmail })`.
  - When result is `{ kind: 'applied', preAccountFlow: { isPreAccount: true } }`,
    branch:
    - User has no credentials → `mintClaimToken` + `sendTransactionalEmail(renderClaimEmail(...))`.
    - User has credentials (existing real user) →
      `sendTransactionalEmail(renderFyiEmail(...))`.
  - Email-send failures: log and continue (don't fail the webhook).

## 6. Claim API

- [ ] 6.1 `src/app/api/auth/claim/route.ts`:
  - `POST`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
  - Bearer claim-token in `Authorization: Bearer <token>`.
  - Body: same shape as `/api/auth/signup` minus `email` (server gets
    email from the claim row).
  - Validates token via `verifyClaimToken`; 401 `CLAIM_TOKEN_INVALID`
    on miss; 401 `CLAIM_TOKEN_EXPIRED` on expiry;
    409 `CLAIM_TOKEN_CONSUMED` on already-consumed.
  - Validates credential block exactly like signup (KDF params,
    32-byte serverPassword, 16-byte salt, base64 decode, etc.).
  - `consumeClaimToken(token)` atomic.
  - `attachAuthCredentialsToUser({ userId, … })`.
  - `mintAccessToken` + `issueFreshChain`.
  - Returns `{ userId, email, accessToken, refreshToken, subscriptionStatus }`.
- [ ] 6.2 `src/app/api/auth/claim/resend/route.ts`:
  - `POST`, bearer claim-token, 60s rate limit per token via
    `last_sent_at`.
  - On allowed: re-render claim email, send via Brevo, bump
    `last_sent_at` + `resend_count`.
  - Returns `{ ok: true }`.
  - 429 `RATE_LIMITED` when called inside the 60s window.

## 7. Confirmation page

- [ ] 7.1 `src/app/endstate/claim/[token]/page.tsx`:
  - RSC. Reads `params.token`, calls `verifyClaimToken(token)`.
  - Valid → render confirmation: greeting, plaintext code
    (formatted `XXXX-XXXX-XXXX-XXXX`), copy-to-clipboard button
    (small `'use client'` island), `endstate://claim?token=<token>`
    button, Endstate download link, FAQ ("what is a claim code?").
  - Expired → "Your link has expired. Email founder@…" with mailto
    fallback.
  - Consumed → "This link has already been used. If you signed in
    successfully you're done; otherwise email founder@…".
  - Invalid → 404 with generic copy.
  - No fancy framer-motion; matches the existing simple page style of
    `/endstate/why` or `/terms` rather than the dynamic `/endstate`
    layout.

## 8. Signup PENDING_CLAIM collision

- [ ] 8.1 In `src/app/api/auth/signup/route.ts`:
  - On `findUserByEmail` hit, check `userHasAuthCredentials(existing.id)`.
  - If false → throw a new `errors.pendingClaim()` (HTTP 409,
    `error.code = 'PENDING_CLAIM'`,
    `message = 'A purchase is pending claim for this email. Check
    your inbox for the claim link or email founder@…'`).
  - If true → existing `errors.emailTaken()` path.
- [ ] 8.2 Add `pendingClaim` factory to `src/lib/hosted-backup/errors.ts`.
- [ ] 8.3 Add `PENDING_CLAIM` to the documented signup error union
  in `src/lib/hosted-backup/types.ts` (or wherever signup response
  errors are typed).

## 9. Cron follow-up

- [ ] 9.1 `src/app/api/cron/claim-followups/route.ts`:
  - Verify the cron secret per the existing
    `src/app/api/cron/backup-gc/route.ts` pattern.
  - Find resendable claims via `findResendableClaims({ now })`;
    re-render + send + bump `resend_count` + `last_sent_at`.
  - Find founder-alertable claims via
    `findFounderAlertableClaims({ now })`; if any, render digest, send
    to `CLAIM_FOUNDER_ALERT_EMAIL` (default
    `founder@substratesystems.io`), `markFounderAlerted(...)`.
  - Returns `{ resent: N, founderAlerted: M }`.
- [ ] 9.2 Document Vercel cron schedule: daily at 12:00 UTC. (Vercel
  cron config lives at `vercel.json`; add an entry there.)

## 10. Tests

- [ ] 10.1 `src/lib/hosted-backup/__tests__/claim-tokens.test.ts`:
  mint → verify → consume; expired token rejected; double-consume
  rejected; hash-not-token storage invariant; cron-filter queries
  return expected rows for boundary times.
- [ ] 10.2 `src/app/api/auth/claim/__tests__/route.test.ts`:
  401 missing token; 401 invalid token; 401 expired; 409 consumed;
  happy path returns JWTs + subscriptionStatus; double-claim returns
  409 the second time.
- [ ] 10.3 `src/app/api/auth/claim/resend/__tests__/route.test.ts`:
  happy path bumps counters; rate-limit returns 429.
- [ ] 10.4 Extend `src/lib/hosted-backup/__tests__/paddle-webhook.test.ts`
  (or add a new test file):
  - `subscription.created` with no `custom_data`, no
    `paddle_customer_id` match → email-fetch path → pre-account
    created + claim email sent.
  - Same event for an email matching an existing user with
    `auth_credentials` → FYI email sent, no claim token minted.
  - Same event for an email matching an existing pre-account → no
    new user, new claim token minted (replaces any prior unconsumed
    token).
  - Paddle email-fetch failure → falls back to `unknown_user`
    response.
- [ ] 10.5 Extend `src/app/api/auth/signup/__tests__/route.test.ts`
  (or add one if missing): conflict against pre-account email returns
  409 `PENDING_CLAIM`; conflict against fully-credentialed user
  returns 409 `EMAIL_TAKEN`.

## 11. Validation

- [ ] 11.1 `npm run openspec:validate` passes strict.
- [ ] 11.2 `npm run build` succeeds (Next.js production build,
  no TS errors).
- [ ] 11.3 All test files in this PR pass; the broader test suite
  (114+ existing tests) passes unchanged.
- [ ] 11.4 `npm run migrate:dry` shows only 0014 as pending.

## 12. Manual sandbox verification

- [ ] 12.1 Apply 0014 against a Neon dev branch.
- [ ] 12.2 Submit a signed `subscription.created` event (sandbox
  Paddle webhook fixture) with no `custom_data.user_id` and a
  `customer_id` that returns a fresh email from the Paddle sandbox
  API:
  - Verify `users` row created (email only).
  - Verify `subscriptions` row created with `status = 'active'`.
  - Verify `claim_tokens` row created.
  - Verify Brevo (or the test no-op) was called with the claim
    template.
- [ ] 12.3 Hit `/endstate/claim/<token>` → confirmation page renders
  with code + Open-in-Endstate button.
- [ ] 12.4 POST `/api/auth/claim` with the token + a dummy credential
  block → response includes JWTs + `subscriptionStatus: 'active'`.
- [ ] 12.5 Re-POST same token → 409 `CLAIM_TOKEN_CONSUMED`.
- [ ] 12.6 POST `/api/auth/signup` with the pre-account email →
  409 `PENDING_CLAIM`.

## 13. Archive

- [ ] 13.1 After merge + production deploy + first successful
  webhook-driven pre-account claim, move this change directory to
  `openspec/changes/archive/<YYYY-MM-DD>-wire-anonymous-buyer-account-linking/`.
