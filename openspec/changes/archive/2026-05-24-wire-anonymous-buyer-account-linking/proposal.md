## Why

PR #11 (`wire-up-endstate-storefront-checkout`, archived 2026-05-24)
shipped the marketing-page CTA on `/endstate` that opens a Paddle
overlay for Hosted Backup monthly + yearly. Because there's no
authenticated session on `/endstate`, those Paddle transactions land
WITHOUT `custom_data.user_id`. The webhook receiver's existing
resolution fallback (`findUserIdByPaddleCustomerId`) also fails for
the very first `subscription.created` event — the lookup table is the
same `subscriptions` row the event is supposed to populate. The
receiver returns `{ ok: true, unknown_user: true }`, Paddle records
the payment, the buyer's card is charged, **and substrate has no
record they exist**. They cannot use Hosted Backup because they have
no Endstate account.

PR #11 acknowledged this as a non-uniformity to handle in a follow-up.
This is that follow-up. Until it ships, we should not drive marketing
traffic to `/endstate` — the funnel leaks at the moment of payment.

The design was locked via brainstorm 2026-05-24 (see
`Knowledge Base/Notes/Research/Endstate/hosted-backup-checkout-remaining-tracks-2026-05-22`
for the launch context):

1. Anonymous buyers must be supported (no pre-purchase auth gate).
2. Web has no login UI; the GUI runs the existing crypto setup.
3. Pre-accounts are modeled as `users` rows without `auth_credentials`
   (no new "orphan" table).
4. Existing-email collision → auto-link + FYI email.
5. Email → web confirmation page → code + Open-in-Endstate button.
6. Unclaimed: resend at 24h + 7d; founder alert at 14d (no auto-cancel).

## What Changes

### 1. Webhook gains email-based fallback (`subscription.created`)

`POST /api/webhooks/paddle` SHALL, when neither
`event.data.custom_data.user_id` nor
`findUserIdByPaddleCustomerId(customer_id)` resolves a user for a
`subscription.created` event, fetch the buyer email from Paddle via
the existing `fetchPaddleCustomerEmail(customer_id)`. With the email
in hand, the handler SHALL resolve a user via `ensurePreAccount(email)`:

- **Email matches an existing user row** → use that user_id; do not
  create a new row.
- **Email matches no user row** → create a new `users` row (email
  only, no `auth_credentials`). This is a *pre-account*.

The webhook then proceeds with the standard
`upsertSubscription(...)` against the resolved user_id. After the
upsert, the handler SHALL:

- If the user has NO `auth_credentials` (pre-account, whether newly
  created or previously orphaned) → mint a `claim_tokens` row,
  send the claim email via Brevo.
- If the user HAS `auth_credentials` (a real user got a sub via the
  marketing CTA) → send the FYI email via Brevo.

For events OTHER than `subscription.created`, the existing
`unknown_user` path is preserved — these are renewals/cancellations
for subscriptions that should already be linked by the time they fire.

### 2. New `claim_tokens` table (migration 0014)

```
CREATE TABLE claim_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  resend_count smallint NOT NULL DEFAULT 0,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX claim_tokens_user_id_idx
  ON claim_tokens (user_id) WHERE consumed_at IS NULL;
```

The plaintext 32-byte random token lives only in the email URL and
the GUI paste-code; server stores only the SHA-256 hash. Tokens
expire after 30 days; consumption is single-use.

### 3. New routes

- `GET /endstate/claim/[token]` — public Next.js page. Validates the
  token (exists, not expired, not consumed) and renders one of:
  - **Valid:** confirmation copy + plaintext code (formatted as
    `XXXX-XXXX-XXXX-XXXX`) + `endstate://claim?token=…` button +
    Endstate download link.
  - **Expired/consumed/invalid:** error page with a "request a new
    link" CTA pointing at a "contact founder@" mailto (out of scope
    for v1 to build a self-service resend on the consumed path).
  - Does NOT consume the token; consumption happens in the GUI's POST.
- `POST /api/auth/claim` — bearer auth via the claim token (NOT a
  standard access token). Body: same credentials shape as
  `/api/auth/signup` (`serverPassword`, `salt`, `kdfParams`,
  `wrappedDEK`, `recoveryKeyVerifier`, `recoveryKeyWrappedDEK`).
  Server: validates token → consumes it → calls
  `insertAuthCredentials(userId, …)` → issues access + refresh JWTs →
  returns `{ userId, email, accessToken, refreshToken, subscriptionStatus }`.
- `POST /api/auth/claim/resend` — bearer auth via the claim token.
  Triggers an immediate resend of the claim email; bumps
  `resend_count` / `last_sent_at`. Rate-limited to one call per
  60 seconds per token.

### 4. Signup `PENDING_CLAIM` collision path

`POST /api/auth/signup` currently errors on email-already-taken
indiscriminately. SHALL be extended: when the conflicting `users` row
has NO `auth_credentials`, respond with HTTP 409 and
`error.code = 'PENDING_CLAIM'` and
`message = 'Check your inbox for a claim link…'`. This prevents an
attacker who knows a buyer's email from racing the legitimate buyer
to set credentials. The buyer must use the email link.

### 5. Cron follow-up (`/api/cron/claim-followups`)

Daily cron route in the existing pattern of
`src/app/api/cron/backup-gc/route.ts`. Job:

- Find unconsumed `claim_tokens` where:
  - `expires_at > now()` (still claimable)
  - `last_sent_at < now() - INTERVAL '23 hours'` (don't double-send)
  - `resend_count < 2` (cap at 2 resends per token)
- For each: send the resend email, bump counts.
- Separately: find unconsumed `claim_tokens` where
  `created_at < now() - INTERVAL '14 days'` AND no founder-alert has
  been sent (tracked via a `founder_alerted_at` column added at the
  same time as the table). Send a single digest email to founder@
  listing the orphaned claims; mark them alerted.

### 6. Reuse

- `sendTransactionalEmail` in `src/lib/brevo.ts` (already powers
  license-key emails) — used for claim, FYI, resend, founder-alert.
- `fetchPaddleCustomerEmail` in `src/lib/license/paddle.ts` — used by
  the webhook fallback.
- `insertUser`, `findUserByEmail`, `insertAuthCredentials` in
  `src/lib/hosted-backup/db.ts` — reused for pre-account creation and
  credential attachment.
- `mintAccessToken` + `issueFreshChain` in `src/lib/hosted-backup/jwt.ts`
  + `src/lib/hosted-backup/refresh.ts` — issue JWTs after claim.
- Existing cron pattern at `src/app/api/cron/backup-gc/route.ts`.
- The `subscriptions` table and webhook state machine are unchanged
  beyond the new resolution fallback.

## Capabilities

### Modified Capabilities

`hosted-backup-subscriptions`: gains email-based pre-account
resolution for unauthenticated `subscription.created` events; gains
the claim-token bootstrap protocol (mint at webhook time, consume at
`POST /api/auth/claim`); the existing `unknown_user` response is now
the *last* resort (after `custom_data` → `paddle_customer_id` →
email-via-Paddle-API).

### Added Capabilities

`hosted-backup-claim-flow`: new capability covering the claim
endpoints, the confirmation page, the cron follow-up, the
`PENDING_CLAIM` signup error path, and the email templates.

## Impact

- **New migration:** `migrations/0014_claim_tokens.sql`.
- **New files:**
  - `src/lib/hosted-backup/claim-tokens.ts`
  - `src/lib/email-templates/claim.ts`
  - `src/app/endstate/claim/[token]/page.tsx`
  - `src/app/api/auth/claim/route.ts`
  - `src/app/api/auth/claim/resend/route.ts`
  - `src/app/api/cron/claim-followups/route.ts`
  - Test files under `src/lib/hosted-backup/__tests__/` and
    `src/app/api/auth/claim/__tests__/`.
- **Modified files:**
  - `src/app/api/webhooks/paddle/route.ts` — pre-account orchestration
    after `unknown_user` fork.
  - `src/lib/hosted-backup/subscriptions.ts` — `applyPaddleEvent`
    accepts an optional `emailLookup` + `preAccount` injection.
  - `src/lib/hosted-backup/db.ts` — `ensurePreAccount`,
    `userHasAuthCredentials`, helpers for the claim_tokens table.
  - `src/app/api/auth/signup/route.ts` — `PENDING_CLAIM` collision
    branch.
  - `src/lib/hosted-backup/types.ts` — claim request/response types,
    `PENDING_CLAIM` error code.
- **New env vars:**
  - `CLAIM_FOUNDER_ALERT_EMAIL` (optional, defaults to
    `founder@substratesystems.io`) — recipient for the 14-day digest.
- **No changes to:** webhook signature verification, idempotency,
  existing `findUserIdByPaddleCustomerId` fallback, GUI auth flow,
  Paddle Customer Portal (separate side-track PR).
