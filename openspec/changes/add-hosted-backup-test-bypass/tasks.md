## 1. Auth middleware

- [ ] 1.1 In `src/lib/hosted-backup/auth-middleware.ts`, add a module-private
  helper `getTestEmailBypassPattern()` that reads
  `process.env.HOSTED_BACKUP_TEST_EMAIL_PATTERN`, returns `null` if empty,
  compiles the value to a `RegExp` otherwise, and caches the compiled regex
  keyed on the source string so subsequent calls with the same env value
  reuse the cached regex. Invalid regex sources SHALL be caught: log a
  one-time `console.warn` per source and return `null` (bypass disabled).
- [ ] 1.2 Modify `requireWriteAccess` so that, after `requireAuth` succeeds
  and before calling `getSubscriptionStatus`, it consults the bypass
  pattern. If a pattern is active, look up the user's email via
  `findUserById(ctx.userId)`. On match, log a `console.warn` line of the
  form `[hosted-backup] subscription gate bypassed for test account
  user=<userId>` and return `ctx` directly (using the JWT-claim
  `subscriptionStatus`, no live DB read). On miss, fall through to the
  existing live DB check.
- [ ] 1.3 Add a JSDoc block above `requireWriteAccess` explaining the
  `HOSTED_BACKUP_TEST_EMAIL_PATTERN` env var, its purpose (engine smoke
  testing against production), and that it MUST remain unset in any
  deployment that should enforce the paywall for all users.
- [ ] 1.4 No change to `requireReadAccess`; document with a single-line
  comment that the bypass intentionally does not apply to read paths.

## 2. Tests

- [ ] 2.1 Extend `src/lib/hosted-backup/__tests__/subscription-gating.test.ts`
  with a new `describe('requireWriteAccess test-email bypass', ...)` block.
  Mocks `findUserById` alongside the existing `getSubscriptionStatus` and
  `getActiveAndRecentlyRetiredSigningKeys` mocks.
- [ ] 2.2 Test: when `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is unset, a user
  with DB status `none` is rejected (preserves existing behavior — guards
  against a regression where the bypass leaks into the default code path).
- [ ] 2.3 Test: when the pattern is set and the user's email matches, a
  user with DB status `none` is allowed through and the returned context
  carries the userId.
- [ ] 2.4 Test: when the pattern is set and the user's email does NOT
  match, a user with DB status `none` is rejected with
  `SUBSCRIPTION_REQUIRED`.
- [ ] 2.5 Test: when the pattern is set to an invalid regex source, all
  users are gated normally (the bypass is disabled, not "fail open").
- [ ] 2.6 Confirm `requireReadAccess` is not affected by the env var by
  asserting that, with the pattern set and matching, a user with DB
  status `none` still receives `SUBSCRIPTION_REQUIRED` on read.

## 3. Validation

- [ ] 3.1 `npm run openspec:validate` passes.
- [ ] 3.2 `npm test` passes (full suite).
- [ ] 3.3 Manual: the engine-side smoke test will be re-run after this
  change is deployed to Vercel production with
  `HOSTED_BACKUP_TEST_EMAIL_PATTERN=^smoketest\+\d+@example\.com$` set.
  This is out of scope for the substrate PR but is the acceptance signal
  for the change as a whole.
