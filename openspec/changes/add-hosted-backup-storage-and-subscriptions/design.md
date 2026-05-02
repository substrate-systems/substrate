## Context

PR1 (`add-hosted-backup-auth`, merged) shipped users + JWTs + OIDC + JWKS + refresh-token rotation. It deliberately stubbed `getSubscriptionStatus` to `'none'` because (a) the `subscriptions` table didn't exist and (b) the storage routes that consume that status weren't yet built.

This change closes that gap. It implements the rest of the substrate-side hosted-backup surface: encrypted backup metadata + R2 presigned URLs (contract §7, §8), the Paddle subscription state machine (§10), and GDPR account deletion (§12). These ship together because every storage route needs subscription gating, the JWT `subscription_status` claim needs a real source row to read, and account deletion cascades across both storage and subscription tables. Splitting them creates a meaningless intermediate state.

Engine (Go) and GUI (Tauri) integration is out of scope; those are subsequent prompts.

## Goals / Non-Goals

**Goals:**

- Implement contract §7 backup metadata API surface end-to-end.
- Mint per-chunk presigned R2 URLs (PUT for upload, GET for download), 5-min TTL.
- Enforce 1-GiB quota at version creation, summed over non-deleted versions across all the user's backups.
- Enforce 5-version retention per backup; soft-delete oldest beyond, with 7-day GC window for accidental-deletion recovery.
- Implement the contract §10 subscription state machine; webhook handler is idempotent on `event_id` and reuses the existing `verifyPaddleSignature`.
- Wire the JWT `subscription_status` claim (and the `requireWriteAccess`/`requireReadAccess` middleware) to the real `subscriptions` table — the claim is a hint, the DB row is authoritative.
- GDPR-compliant `DELETE /api/account` per contract §12: synchronous Postgres cascade, audit log keyed by `SHA-256(userId)`, R2 prefix marked for async purge.

**Non-Goals:**

- Engine or GUI implementation.
- Cron schedule for the R2 garbage collector — handler stub only; Hugo wires the schedule separately.
- R2 deletion queue infrastructure — for v1 we record the prefix in the audit log and rely on the cron stub (described below); a richer pending_deletions table is a v1.x addition if real volume justifies it.
- Email notifications for any subscription transition — deferred to v1.x per the prompt.
- Edge rate limiting on the webhook — the same edge config that protects auth covers it.
- Content-addressed deduplication across versions — contract §8 explicitly defers this to v2.

## Decisions

**One PR for storage + subscriptions + deletion despite three OpenSpec capabilities.**
The original prompt suggested three PRs. After PR1 merged, splitting storage from subscriptions creates an in-between state where storage routes exist but `getSubscriptionStatus` still returns `'none'`, so every `POST /api/backups` is blocked — there's nothing meaningful to ship from PR2 alone. Combining them avoids that. Each capability still has its own spec delta for clear contract surface tracking.

**Subscription gating is enforced at the route layer, not just the DB.**
`requireWriteAccess(req)` re-reads `subscriptions.status` for the authenticated user and gates writes on `status = 'active'`. The JWT claim is a UX hint with up to 15-minute staleness; the route check uses the live DB read. Reading is allowed in `active`, `grace`, and `cancelled` per contract §10 (subscription lapse is the worst time to lock users out of their own data).

**R2 backend uses the AWS S3 SDK with R2's S3-compatible endpoint.**
R2 is fully S3-compatible at the API level. Using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` gets us presigned URL signing for free, and the same library works against AWS S3 if a self-hoster wants that. Set `endpoint = process.env.R2_ENDPOINT`, `region: 'auto'`, `forcePathStyle: true`. 5-minute presigned URL TTL per contract §8.

**Quota enforcement is a SQL aggregate at version-creation time, not a per-user counter column.**
The aggregate `SELECT COALESCE(SUM(size_bytes), 0) FROM backup_versions WHERE backup_id IN (SELECT id FROM backups WHERE user_id = $1) AND deleted_at IS NULL` runs in microseconds at the table sizes we expect; a counter column would create write contention and could drift. Quota limit defaults to 1 GiB (contract §8) and is overridable via `HOSTED_BACKUP_QUOTA_BYTES` for self-hosters.

**Version retention is enforced after a successful create, soft-deleting the oldest beyond five.**
After the new version row is committed, we run `UPDATE backup_versions SET deleted_at = now() WHERE backup_id = $1 AND deleted_at IS NULL AND id NOT IN (SELECT id FROM backup_versions WHERE backup_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5)`. The 7-day soft-delete window per contract §8 is purely a GC concern — the row vanishes from listings immediately. Hard delete (R2 purge) is the cron's job and is deferred.

**Paddle webhook idempotency uses `INSERT ... ON CONFLICT DO NOTHING`.**
The same race-recovery pattern as the existing license webhook. Insert `paddle_webhook_events (event_id, event_type)` first; if the rowCount is 0, this is a duplicate — return 200 and skip processing. Otherwise process the event, then `UPDATE ... SET processed_at = now()`. Fully idempotent under retries and concurrent delivery.

**`subscription.canceled` ↔ `cancelled` spelling adapter is at the webhook boundary only.**
Paddle emits `subscription.canceled` (one l, US English). The contract §10 internal state is `cancelled` (two l's, en-GB / matches `auth_credentials` etc. style). The mapping happens once in `applyPaddleEvent`; the rest of the codebase only ever sees `cancelled`.

**Account deletion is hard-delete in Postgres, async-mark in R2.**
Contract §12 specifies hard-delete. Postgres FKs cascade from `users` through every dependent table — single `DELETE FROM users WHERE id = $1` removes everything. R2 object purging takes minutes-to-hours over a 1-GiB user; doing it synchronously would block the response. Instead, we INSERT into `audit_log_account_deletions` with `reason = 'user_request'` and `user_id_hash = sha256(userId)`, and write the R2 prefix to the cron's deletion log. The user's response is 200 once Postgres rows are gone and Paddle is notified; R2 purge completes within 24 hours via the deferred cron.

**Audit log uses `SHA-256(userId)`, not the raw UUID.**
Contract §12 specifies this — gives us "did this user delete?" queryability if the user later asks, without retaining identifying information. The hash is stable since UUIDs are stable.

**Paddle cancel-on-delete is best-effort.**
If `cancelPaddleSubscription` throws (Paddle API down, unknown subscription ID, etc.), we log and continue. The Postgres cascade still runs. Better to leave a dangling Paddle subscription that will eventually fail to charge (and fire `subscription.past_due` then `subscription.canceled` events into a webhook handler that finds no user to update — also a no-op) than to fail the user's account-delete request.

**Cron stub returns 200 with a `todo` field — not 501.**
A 501 would imply "this might work eventually." The endpoint is a placeholder that intentionally does nothing today. 200 + `{ ok: true, todo: '...' }` is unambiguous: "we know this is here, we know it's not wired up yet, the schedule will be configured in a separate change."

## Risks / Trade-offs

- **[Risk] R2 leak when account is deleted but cron hasn't run.** → Mitigation: the deletion is recorded in `audit_log_account_deletions`; cron picks up un-purged prefixes by reading recent audit-log rows. The blobs are still encrypted with a DEK only the user's passphrase could unwrap, so the leak is "encrypted-blob persistence" not "data leak." Acceptable for the v1 deferred-cron design.
- **[Risk] R2 presigned URL leaks via logs or browser history.** → Mitigation: 5-minute TTL caps the exposure window. Each URL is scoped to a single object key. Standard pattern across S3-compatible providers.
- **[Risk] Quota race when two simultaneous version creates squeak through under the limit individually but exceed it summed.** → Mitigation: `enforceQuota` runs inside the version-create transaction with `SELECT ... FOR UPDATE` on the user's backups. Worst case, one of two simultaneous creates fails with a clear `STORAGE_QUOTA_EXCEEDED`.
- **[Risk] Paddle webhook event arrives before the user's signup transaction commits (rare but possible).** → Mitigation: webhook handler does an upsert keyed by `paddle_subscription_id`; the link to a `user_id` is via `paddle_customer_id`. If we receive `subscription.created` before we know the user, we record the subscription with `user_id = NULL` (column reluctantly relaxed for this edge case)... actually no — better: we look up the user by `paddle_customer_id` (set during signup checkout). If lookup fails, we log and return 200; Paddle will retry, eventually succeeding once the user row exists. Documented in the route.
- **[Trade-off] Single-PR shipping vs. three-PR splits.** → The contract surface is split cleanly into three OpenSpec capabilities, but the implementation is genuinely interdependent. Hugo accepted this trade-off after PR1 merged.
- **[Trade-off] No deletion queue table.** → Audit log doubles as the cron's input. Simpler. If volume justifies a richer queue later, that's a v1.x change.

## Migration Plan

1. **Schema rollout.** Merge this PR; deploy. Run `npm run migrate` against production Neon. Migrations 0005–0010 apply.
2. **R2 setup.** Create the bucket; mint an R2 token with read/write scoped to the bucket. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT` in Vercel env.
3. **Paddle webhook URL.** Update Paddle's webhook URL to add `https://substratesystems.io/api/webhooks/paddle` (in addition to the existing license webhook). Ensure `PADDLE_WEBHOOK_SECRET` is set (already is, from license).
4. **Smoke verification.** End-to-end: signup → login → `POST /api/backups` returns `SUBSCRIPTION_REQUIRED` (expected — status is `none`). Manually upsert a subscription row to `active` for a test user. Repeat the create — succeeds. Create a version with a tiny manifest + 1 chunk. List versions. Request a download URL. Verify the URL is valid for 5 minutes.
5. **Webhook smoke.** Use Paddle's webhook tester (or `curl` with a hand-signed payload) to send a `subscription.created` event with `subscription_id=test123, customer_id=cus_test`. Verify the row appears. Replay the same event — verify dedup.
6. **Account-delete smoke.** `DELETE /api/account` for a test user. Verify all rows for the user are gone. Verify the audit-log row appears with `user_id_hash = sha256(uuid)`. Manually verify the R2 prefix is recorded in the audit log for cron pickup.
7. **Rollback.** This change is purely additive on top of PR1. If a problem appears, redeploy the previous build; the new tables are unused if nothing reaches them.

## Open Questions

- Does the cron want a dedicated `pending_deletions` table or is the audit log enough? Defer to first encounter with real volume.
- Should `requireWriteAccess` rely solely on the live DB read or also fall back to JWT claim if DB is briefly unreachable? Currently strict (DB-only) — if Neon is down, all writes fail. Could add a 5-second cache or a graceful-degradation read of the claim if this proves brittle. Out of scope for v1.
