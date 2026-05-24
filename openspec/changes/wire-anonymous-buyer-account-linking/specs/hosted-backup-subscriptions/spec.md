## MODIFIED Requirements

### Requirement: Webhook resolves user_id via custom_data

`POST /api/webhooks/paddle` SHALL resolve the internal `user_id` for
a subscription event by trying, in order:

1. `event.data.custom_data.user_id` (Paddle Billing API)
2. `event.data.passthrough.user_id` if `passthrough` is an object, or
   `JSON.parse(passthrough).user_id` if it is a string (legacy)
3. `findUserIdByPaddleCustomerId(event.data.customer_id)` (returning
   subscriber whose row was created by an earlier event)
4. **New**: for `subscription.created` events ONLY,
   `fetchPaddleCustomerEmail(event.data.customer_id)` followed by
   `ensurePreAccount(email)`. If the email returns null or the Paddle
   API call fails, fall through to the existing `unknown_user`
   response.

When sources 1–3 fail AND source 4 succeeds, the resolved `user_id`
points to either an existing substrate user or a freshly created
*pre-account* (a `users` row without `auth_credentials`). The webhook
SHALL upsert the `subscriptions` row against this user_id as usual.

After the upsert, the webhook handler SHALL:

- If the user has NO `auth_credentials`, mint a `claim_tokens` row
  for this user and send the claim email via Brevo.
- If the user HAS `auth_credentials`, send the FYI email
  ("Hosted Backup added to your Endstate account") via Brevo.

Email-send failures SHALL NOT fail the webhook (Paddle would retry
indefinitely). They SHALL log a warning and the webhook SHALL still
return 200.

Only when sources 1–4 ALL fail SHALL the handler return its existing
`unknown_user` response (HTTP 200, `unknown_user: true`).

#### Scenario: Subscription.created with no auth context creates a pre-account

- **GIVEN** a `subscription.created` event with no `custom_data`, no
  `passthrough`, and `event.data.customer_id = "cus_anon"`
- **AND** no existing `subscriptions` row carries `paddle_customer_id
  = "cus_anon"`
- **AND** `fetchPaddleCustomerEmail("cus_anon")` returns
  `"new-buyer@example.com"`
- **AND** no existing `users` row carries `email = "new-buyer@example.com"`
- **WHEN** the webhook processes the event
- **THEN** a new `users` row is inserted with that email and no
  `auth_credentials`
- **AND** a `subscriptions` row is upserted with `status = "active"`
  for the new user
- **AND** a `claim_tokens` row is created (token, hash, expires_at =
  now + 30d)
- **AND** the claim email is sent via Brevo to `new-buyer@example.com`
- **AND** the webhook responds 200 `{ ok: true, userId: <new uuid>,
  status: "active" }`

#### Scenario: Existing real user is auto-linked and FYI-emailed

- **GIVEN** an existing `users` row with `email = "alice@example.com"`
  AND a row in `auth_credentials` for that user
- **AND** a `subscription.created` event whose email-fallback path
  returns `"alice@example.com"`
- **WHEN** the webhook processes the event
- **THEN** the `subscriptions` row is upserted against the existing
  user_id (NO new user row created)
- **AND** NO `claim_tokens` row is created
- **AND** the FYI email ("Hosted Backup added…") is sent to
  `alice@example.com`

#### Scenario: Existing pre-account is reused, fresh claim token minted

- **GIVEN** a `users` row for `"bob@example.com"` exists with NO
  `auth_credentials` (pre-account from a prior unclaimed purchase)
- **WHEN** a new `subscription.created` event resolves to the same
  email via fallback
- **THEN** the existing user_id is reused (NO new user row)
- **AND** the `subscriptions` row is upserted against that user_id
- **AND** a NEW `claim_tokens` row is created (the prior token
  remains valid until its own expiry; no consolidation)
- **AND** the claim email is sent

#### Scenario: Paddle email-fetch failure preserves unknown_user response

- **GIVEN** a `subscription.created` event with no `custom_data` and
  no `paddle_customer_id` match
- **AND** `fetchPaddleCustomerEmail(customerId)` throws (e.g. Paddle
  API down)
- **WHEN** the webhook processes the event
- **THEN** the handler logs the email-fetch failure
- **AND** the response is HTTP 200 `{ ok: true, unknown_user: true }`
- **AND** the `paddle_webhook_events` row is marked processed (Paddle
  will not retry)

#### Scenario: Non-`subscription.created` events do not use the email fallback

- **GIVEN** a `subscription.past_due` event with no `custom_data` and
  no `paddle_customer_id` match (an unrecoverable situation for a
  renewal event)
- **WHEN** the webhook processes the event
- **THEN** `fetchPaddleCustomerEmail` is NOT called
- **AND** the response is HTTP 200 `{ ok: true, unknown_user: true }`

## ADDED Requirements

### Requirement: Claim tokens table

A new `claim_tokens` table SHALL persist single-use bearer tokens
that link a pre-account `users` row to a future
`/api/auth/claim` request. Schema:

- `token_hash bytea PRIMARY KEY` (SHA-256 of the random 32-byte
  secret; the plaintext token is never stored server-side)
- `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `email citext NOT NULL` (audit snapshot)
- `created_at timestamptz NOT NULL DEFAULT now()`
- `expires_at timestamptz NOT NULL` (= `created_at + 30 days`)
- `consumed_at timestamptz` (null until claimed)
- `resend_count smallint NOT NULL DEFAULT 0` (cron caps at 2)
- `last_sent_at timestamptz NOT NULL DEFAULT now()`
- `founder_alerted_at timestamptz` (null until the 14d digest fires)

Partial index on `(user_id) WHERE consumed_at IS NULL` accelerates
cron queries.

The plaintext token MUST NOT be persisted; only its SHA-256 is
stored. Token comparisons happen by hashing the candidate and looking
up `token_hash`. Claim-token primitives (`mintClaimToken`,
`verifyClaimToken`, `consumeClaimToken`) SHALL be the only callers
that read or write `claim_tokens`.

#### Scenario: Plaintext token is not stored

- **GIVEN** a fresh call to `mintClaimToken({ userId, email })`
- **WHEN** the call returns `{ token, tokenHash }`
- **THEN** the `claim_tokens` row's `token_hash` column equals
  `sha256(token)` (32 bytes)
- **AND** no column in the row equals the plaintext `token`

#### Scenario: Consumed token row is preserved for audit

- **GIVEN** a `claim_tokens` row that has been consumed via
  `consumeClaimToken`
- **WHEN** subsequent claim attempts arrive for the same token
- **THEN** the row remains in the table with `consumed_at` set
- **AND** the partial index `claim_tokens_user_id_idx` no longer
  matches that row (it filters `WHERE consumed_at IS NULL`)

### Requirement: POST /api/auth/claim consumes a claim token

The endpoint `POST /api/auth/claim` SHALL accept a claim token via
`Authorization: Bearer <token>` and a credential body in the same
shape as `POST /api/auth/signup` (KDF params, 32-byte serverPassword,
16-byte salt, base64-encoded `wrappedDEK`, `recoveryKeyVerifier`,
`recoveryKeyWrappedDEK`). It SHALL:

1. Hash the bearer token; look up `claim_tokens` by `token_hash`.
2. Reject with HTTP 401 `CLAIM_TOKEN_INVALID` if no row.
3. Reject with HTTP 401 `CLAIM_TOKEN_EXPIRED` if `expires_at <= now()`.
4. Reject with HTTP 409 `CLAIM_TOKEN_CONSUMED` if `consumed_at IS NOT
   NULL`.
5. Atomically set `consumed_at = now()` (UPDATE…WHERE consumed_at IS
   NULL); if rowCount is 0 it raced — return 409.
6. Insert `auth_credentials` for the token's `user_id`. If credentials
   already exist (race with another claim or manual setup), return
   HTTP 409 `CLAIM_TOKEN_CONSUMED`.
7. Issue a fresh access token + refresh token chain.
8. Return HTTP 200 `{ userId, email, accessToken, refreshToken,
   subscriptionStatus }`.

#### Scenario: Happy-path claim attaches credentials and returns JWTs

- **GIVEN** a valid unconsumed `claim_tokens` row for user `u-1`
- **AND** `u-1` has no `auth_credentials`
- **WHEN** the client POSTs `/api/auth/claim` with the bearer token
  and a complete credential body
- **THEN** `auth_credentials(u-1)` is inserted
- **AND** the `claim_tokens` row has `consumed_at = <now>`
- **AND** the response is HTTP 200 with `userId = "u-1"`,
  `subscriptionStatus = "active"`, and non-empty
  `accessToken`/`refreshToken`

#### Scenario: Double-claim returns CLAIM_TOKEN_CONSUMED

- **GIVEN** a previously-consumed `claim_tokens` row
- **WHEN** a second POST with the same bearer arrives
- **THEN** the response is HTTP 409 `CLAIM_TOKEN_CONSUMED`
- **AND** `auth_credentials` is NOT modified

#### Scenario: Expired claim returns CLAIM_TOKEN_EXPIRED

- **GIVEN** a `claim_tokens` row with `expires_at = now - 1 hour`,
  `consumed_at IS NULL`
- **WHEN** the client POSTs `/api/auth/claim` with that bearer
- **THEN** the response is HTTP 401 `CLAIM_TOKEN_EXPIRED`

### Requirement: POST /api/auth/claim/resend re-sends with rate limit

`POST /api/auth/claim/resend` SHALL accept the same claim token
bearer. It SHALL:

- 401 `CLAIM_TOKEN_INVALID` / 401 `CLAIM_TOKEN_EXPIRED` / 409
  `CLAIM_TOKEN_CONSUMED` per the same rules as `/api/auth/claim`.
- 429 `RATE_LIMITED` when `last_sent_at > now() - INTERVAL '60
  seconds'`.
- Otherwise re-render the claim email, send via Brevo, set
  `last_sent_at = now()`, increment `resend_count`.

There is NO cap on resends from this endpoint (it's user-triggered
and rate-limited per-token); the cron-triggered cap of 2 is separate.

#### Scenario: Resend within 60s returns 429

- **GIVEN** a `claim_tokens` row with `last_sent_at = now - 30 seconds`
- **WHEN** the client POSTs `/api/auth/claim/resend`
- **THEN** the response is HTTP 429 `RATE_LIMITED`

### Requirement: Signup returns PENDING_CLAIM for pre-account emails

`POST /api/auth/signup` SHALL distinguish, on email collision,
between fully-credentialed users and pre-accounts:

- Email matches a user with `auth_credentials` → HTTP 409
  `EMAIL_TAKEN` (existing behavior).
- Email matches a user WITHOUT `auth_credentials` (pre-account) →
  HTTP 409 `PENDING_CLAIM`, with a message instructing the user to
  check their inbox for the claim link.

This MUST prevent any attacker who learns a buyer's email from
racing the legitimate buyer to insert `auth_credentials` against the
pre-account user_id, which would hijack the subscription. Pre-account
credentials can only be set via `POST /api/auth/claim` with a valid
claim token (proof of email ownership via inbox access).

#### Scenario: Signup against a pre-account email returns PENDING_CLAIM

- **GIVEN** a `users` row for `"carol@example.com"` with NO
  `auth_credentials`
- **WHEN** a client POSTs `/api/auth/signup` with
  `email = "carol@example.com"` and a complete credential body
- **THEN** the response is HTTP 409 `PENDING_CLAIM`
- **AND** the `users` row is unchanged
- **AND** no `auth_credentials` row is inserted

#### Scenario: Signup against a fully-credentialed email returns EMAIL_TAKEN

- **GIVEN** a `users` row for `"dave@example.com"` WITH an
  `auth_credentials` row
- **WHEN** a client POSTs `/api/auth/signup` with that email
- **THEN** the response is HTTP 409 `EMAIL_TAKEN`

### Requirement: Cron nudges unclaimed claim tokens and alerts founder at 14 days

The endpoint `GET /api/cron/claim-followups` SHALL be a
cron-secret-authenticated route invoked daily that performs two
passes against the `claim_tokens` table.

**Pass 1 (nudge)**: the cron SHALL find unconsumed `claim_tokens`
rows where `expires_at > now()` AND `last_sent_at < now() - INTERVAL
'23 hours'` AND `resend_count < 2`. For each matching row the cron
SHALL send a "your purchase is still waiting — reply for a fresh
link" nudge email via Brevo, increment `resend_count`, and set
`last_sent_at = now()`.

The nudge email SHALL NOT contain a claim URL or paste-code, because
the cron only has the SHA-256 hash of the token (the plaintext was
deliberately not persisted at mint time). To send a working
replacement, founder@ replies to the nudge with a freshly-minted
token via a manual workflow. This is an acknowledged v1 limitation;
v1.1 may add encrypted-at-rest tokens or auto-reissue chains to
support fully automated resends.

**Pass 2 (founder alert)**: the cron SHALL find unconsumed
`claim_tokens` rows where `created_at < now() - INTERVAL '14 days'`
AND `founder_alerted_at IS NULL`. If any such rows exist the cron
SHALL render a digest email listing `{email, createdAt,
paddleCustomerId}` for each row, send it to the address in
`CLAIM_FOUNDER_ALERT_EMAIL` (default
`founder@substratesystems.io`), and update `founder_alerted_at =
now()` for every row included in the digest.

The route SHALL return `{ resent: N, founderAlerted: M }` where N is
the count from Pass 1 and M is the count from Pass 2 (the `resent`
field name is preserved for symmetry even though the content is a
nudge rather than a re-issuance).

#### Scenario: Cron nudges a 25h-old unclaimed token

- **GIVEN** a `claim_tokens` row with `last_sent_at = now - 25h`,
  `resend_count = 0`, `consumed_at = NULL`, `expires_at = now + 25d`
- **WHEN** the cron fires
- **THEN** a "your purchase is still waiting" nudge email is sent
  (NOT a claim URL)
- **AND** `resend_count` is now `1`
- **AND** `last_sent_at` is bumped to roughly `now`

#### Scenario: Cron does not nudge if already nudged twice

- **GIVEN** a `claim_tokens` row with `resend_count = 2`,
  `last_sent_at = now - 25h`
- **WHEN** the cron fires
- **THEN** the row is NOT nudged again

#### Scenario: Cron alerts founder for a 14d-old unclaimed token

- **GIVEN** a `claim_tokens` row with `created_at = now - 15d`,
  `consumed_at = NULL`, `founder_alerted_at = NULL`
- **WHEN** the cron fires
- **THEN** a digest email is sent to `CLAIM_FOUNDER_ALERT_EMAIL`
  including that row's `{email, createdAt, paddleCustomerId}`
- **AND** the row's `founder_alerted_at` is set to `now`
- **AND** subsequent cron runs do NOT re-alert for the same row
