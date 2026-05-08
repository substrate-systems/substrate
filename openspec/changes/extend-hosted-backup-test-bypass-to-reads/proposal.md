## Why

The previous change (`add-hosted-backup-test-bypass`) scoped the
`HOSTED_BACKUP_TEST_EMAIL_PATTERN` bypass to writes only, on the
assumption that the engine smoke test only exercised write endpoints.
After deploy we ran the engine smoke test against production three times
and it failed each time with `SUBSCRIPTION_REQUIRED`. Production-runtime
diagnostics confirmed:

- The env var is correctly set in Production (length 29, regex compiles,
  matches `smoketest+<n>@example.com`).
- A test write through `requireWriteAccess` succeeds with HTTP 200 and
  emits the expected `[hosted-backup] subscription gate bypassed for test
  account user=...` log line.
- `GET /api/backups` for the same smoke account returns HTTP 402
  `SUBSCRIPTION_REQUIRED` from `requireReadAccess`, which has no bypass.

The smoke test acceptance criterion is `signup → push → pull →
byte-equal → delete`. The pull step (and any list-before-push) hits read
endpoints (`GET /api/backups`, `GET /api/backups/:id/versions`,
`POST /api/backups/:id/versions/:vid/download-urls`) — all of which call
`requireReadAccess` and reject `status="none"` regardless of email. There
is no path for a fresh smoke account to complete the full cycle while
the read gate stays unconditional.

## What Changes

- `requireReadAccess` in `src/lib/hosted-backup/auth-middleware.ts` gains
  the same bypass step that `requireWriteAccess` already has: after JWT
  validation and before the live `subscriptions` table check, if the env
  var is set and the authenticated user's email matches the compiled
  regex, the subscription check is skipped and `requireReadAccess`
  returns successfully. The DB read for `getSubscriptionStatus` is
  skipped on match; the returned `subscriptionStatus` is the JWT-claim
  value (already documented as a hint).
- The cached regex compilation, the invalid-regex fail-closed behavior,
  the per-bypass `console.warn` audit log, and the cache key are reused
  verbatim — there is one bypass mechanism shared by both gate
  functions.
- JSDoc on both `requireWriteAccess` and `requireReadAccess` is updated
  to reflect the symmetric bypass and the threat model (see below).
- Tests in `subscription-gating.test.ts` add three read-bypass cases
  (matching email allowed, non-matching email rejected, invalid regex
  rejected) paralleling the existing write-bypass cases. The previous
  "bypass does not apply to read endpoints" test is removed because that
  behavior is no longer correct.
- Runbook entry in `docs/runbooks/production-keys-and-storage.md` is
  updated to: (a) state explicitly that the bypass covers reads and
  writes, (b) explain why (smoke-test acceptance criterion), and (c)
  document the threat model.

### Threat model (added to runbook)

The bypass is safe because it is gated by **two** conditions, both
operator-controlled:

1. **Env var set to a regex** — `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is
   set only in Vercel project settings. Anyone with permission to set
   it already has full admin control of substrate (env vars, secrets,
   deploys). The bypass cannot be enabled by an end user, by a backup
   client, or by a webhook.
2. **Email matches the regex at signup time** — substrate stores the
   email submitted at signup. The regex is `^smoketest\+\d+@example\.com$`,
   which no real user could plausibly match: `example.com` is reserved
   per [RFC 2606](https://datatracker.ietf.org/doc/html/rfc2606), and
   the literal `smoketest+` prefix is not a pattern any organic
   signup would produce.

Worst case: an operator misconfigures the regex to something
permissive (e.g. `^.*$`) and effectively gives free hosted backup to
everyone until corrected. This is bounded by operator control and
mitigated by the per-bypass `console.warn` audit log, which surfaces
the user id of every account that takes the bypass — an unexpected
spike is easy to spot in Vercel runtime logs.

## Capabilities

### Modified Capabilities

- `hosted-backup-subscriptions`: the existing requirement
  *Operator-controlled test-email bypass on write endpoints* is replaced
  by *Operator-controlled test-email bypass on read and write endpoints*.
  Two scenarios are removed (the read-no-bypass scenario), three are
  added (read with matching email allowed, read with non-matching email
  rejected, read with invalid regex rejected). The default-no-bypass
  invariant is preserved.

## Impact

- One file changed in production code (`auth-middleware.ts`).
- One test file extended; one stale test removed.
- No schema changes, no new env vars, no new dependencies, no new routes.
- Production verification post-merge: a curl-based round-trip (signup
  → POST /api/backups → GET /api/backups → DELETE /api/account) using
  a smoketest+ email should succeed at every step with no
  `SUBSCRIPTION_REQUIRED` response. Same recipe documented in the
  runbook.
