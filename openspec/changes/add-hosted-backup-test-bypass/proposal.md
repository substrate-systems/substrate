## Why

The hosted-backup engine smoke test signs up a fresh test account, pushes a
backup, pulls it, byte-compares, then deletes the account. Substrate correctly
rejects `POST /api/backups` and `POST /api/backups/:id/versions` when the user
has no active subscription (contract §10), so the smoke test cannot complete
end-to-end against production without going through the Paddle checkout flow
on every run — which is impractical and expensive.

We need a narrow, operator-controlled bypass that exempts a known test-account
email pattern from the subscription gate on write endpoints, while keeping the
gate fully active for every real user.

## What Changes

- New env var: `HOSTED_BACKUP_TEST_EMAIL_PATTERN` (string, default empty).
  When non-empty it MUST be a valid JavaScript `RegExp` source. When empty or
  unset, behavior is unchanged from today.
- `requireWriteAccess` in `src/lib/hosted-backup/auth-middleware.ts` gains a
  bypass step that runs after JWT validation and before the DB subscription
  check. If the env var is set and the authenticated user's email matches the
  compiled regex, the subscription check is skipped and `requireWriteAccess`
  returns successfully. The DB read for `getSubscriptionStatus` is also
  skipped; the returned `subscriptionStatus` is the JWT-claim value (already
  documented as a hint).
- `requireReadAccess` and the rest of the auth surface are unchanged. Read
  endpoints already permit `active`, `grace`, and `cancelled`, so no bypass
  is needed there.
- Invalid regex source SHALL NOT crash the service. The compile attempt logs a
  warning and the bypass is disabled (every user is gated normally) until the
  env var is corrected.
- Tests cover: default empty pattern still gates non-active users; matching
  email with status `none` is allowed through; non-matching email with status
  `none` is still rejected; invalid regex disables the bypass.

## Capabilities

### Modified Capabilities

- `hosted-backup-subscriptions`: adds a new requirement for the operator-only
  test-email bypass on write endpoints. The existing "Write/read gating per
  state" requirement is unchanged at the spec level — the bypass is an
  explicit, separately-named exception that does not weaken the default rule
  for users whose email does not match the pattern.

## Impact

- One file changed in production code (`auth-middleware.ts`).
- One test file extended (`subscription-gating.test.ts`).
- One new optional env var. Default behavior is unchanged when the var is
  unset, which is the configuration in every environment except where an
  operator deliberately enables it.
- No schema changes, no new dependencies, no new routes.
