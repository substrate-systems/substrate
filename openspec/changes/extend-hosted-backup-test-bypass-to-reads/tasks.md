## 1. Auth middleware

- [ ] 1.1 In `src/lib/hosted-backup/auth-middleware.ts`, modify
  `requireReadAccess` to consult `getTestEmailBypassPattern()` after
  `requireAuth` and before `getSubscriptionStatus`, mirroring
  `requireWriteAccess`. On a match, log
  `[hosted-backup] subscription gate bypassed for test account user=<id>`
  and return `ctx` with the JWT-claim `subscriptionStatus`.
- [ ] 1.2 Reuse the shared `getTestEmailBypassPattern()` helper, the
  shared `bypassCache`, and the same fail-closed-on-invalid-regex
  behavior. No new module-level state.
- [ ] 1.3 Replace the JSDoc on `requireWriteAccess` so the bypass
  description applies to "writes (this function) AND reads (sibling
  `requireReadAccess`)" rather than "writes only."
- [ ] 1.4 Replace the JSDoc on `requireReadAccess` so it documents
  the symmetric bypass and references the threat model in the runbook.
- [ ] 1.5 Update the `// Test-only bypass: see the JSDoc on
  requireWriteAccess` comment near the cache var to reference both
  gate functions.

## 2. Tests

- [ ] 2.1 Remove the existing `it('bypass does not apply to read
  endpoints', ...)` test in
  `src/lib/hosted-backup/__tests__/subscription-gating.test.ts` — that
  expectation is now incorrect.
- [ ] 2.2 Add a new `describe('requireReadAccess test-email bypass',
  ...)` block in the same file with three cases, paralleling the
  existing write-bypass block:
  - pattern set + matching email + status `none` → read allowed
  - pattern set + non-matching email + status `none` → read rejected
    with `SUBSCRIPTION_REQUIRED`
  - pattern set to invalid regex source + status `none` → read
    rejected (bypass disabled, fail closed)
- [ ] 2.3 Confirm the existing "default empty pattern blocks reads
  for status `none`" coverage is still asserted by the unchanged
  `requireReadAccess > blocks when DB status is none` test.

## 3. Runbook

- [ ] 3.1 In `docs/runbooks/production-keys-and-storage.md`, update
  the *How it works* bullet to read "Read AND write paths" instead of
  "write only," and remove the "Read endpoints intentionally do not
  honor the bypass" sentence.
- [ ] 3.2 Add a *Why both reads and writes* paragraph explaining the
  smoke-test acceptance criterion (`signup → push → pull → byte-equal
  → delete`) and that the pull step requires read access.
- [ ] 3.3 Add a *Threat model* subsection covering the two-condition
  guard (operator-set env var + RFC 2606 reserved-domain regex), the
  worst-case operator misconfiguration, and the audit log mitigation.
- [ ] 3.4 Update the production verification curl recipe to include
  both POST `/api/backups` (write) and GET `/api/backups` (read) — a
  successful smoke-bypass run hits 200 on both, with no
  `SUBSCRIPTION_REQUIRED` response anywhere in the round-trip.

## 4. Validation

- [ ] 4.1 `npm run openspec:validate` passes.
- [ ] 4.2 `npm test` passes (full suite).
- [ ] 4.3 Manual production verification post-merge: provision
  `smoketest+<unix-time>@example.com`, run signup → POST /api/backups
  → GET /api/backups → DELETE /api/account, all with HTTP 200.
