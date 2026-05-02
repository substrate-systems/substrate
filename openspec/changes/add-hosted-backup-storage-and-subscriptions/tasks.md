## 1. Schema

- [ ] 1.1 `migrations/0005_backups.sql` — `backups` table (`id uuid pk default gen_random_uuid()`, `user_id uuid not null references users(id) on delete cascade`, `name text not null`, `created_at timestamptz default now()`, `updated_at timestamptz default now()`, `deleted_at timestamptz`). Index `(user_id, deleted_at)`.
- [ ] 1.2 `migrations/0006_backup_versions.sql` — `backup_versions` table (`id uuid pk default gen_random_uuid()`, `backup_id uuid not null references backups(id) on delete cascade`, `created_at timestamptz default now()`, `size_bytes bigint not null`, `manifest_object_key text not null`, `manifest_sha256 bytea not null`, `chunk_count int not null`, `deleted_at timestamptz`). Index `(backup_id, deleted_at, created_at desc)`.
- [ ] 1.3 `migrations/0007_backup_chunks.sql` — `backup_chunks` table (`version_id uuid references backup_versions(id) on delete cascade`, `chunk_index int`, `object_key text not null`, `size_bytes int not null`, `sha256 bytea not null`, primary key `(version_id, chunk_index)`).
- [ ] 1.4 `migrations/0008_subscriptions.sql` — `subscriptions` table (`user_id uuid pk references users(id) on delete cascade`, `paddle_subscription_id text unique`, `paddle_customer_id text`, `status text not null default 'none' check (status in ('none','active','grace','cancelled'))`, `grace_started_at timestamptz`, `cancel_started_at timestamptz`, `current_period_end timestamptz`, `updated_at timestamptz default now()`).
- [ ] 1.5 `migrations/0009_paddle_webhook_events.sql` — `paddle_webhook_events` table (`event_id text pk`, `event_type text not null`, `received_at timestamptz default now()`, `processed_at timestamptz`).
- [ ] 1.6 `migrations/0010_audit_log_account_deletions.sql` — `audit_log_account_deletions` table (`user_id_hash bytea not null`, `deleted_at timestamptz default now()`, `reason text not null`). Index on `(user_id_hash)`.

## 2. Library

- [ ] 2.1 Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `dependencies`. Run install.
- [ ] 2.2 `src/lib/hosted-backup/r2.ts` — lazy S3 client targeting R2 (`endpoint = process.env.R2_ENDPOINT`, `region: 'auto'`, `forcePathStyle: true`, credentials from `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`). Helpers `presignPut(objectKey, contentLength?)` and `presignGet(objectKey)` using `getSignedUrl` with 5-minute (300s) TTL.
- [ ] 2.3 `src/lib/hosted-backup/storage.ts` — typed query layer over the new tables: `createBackup`, `listBackupsForUser`, `getBackupOwned`, `softDeleteBackup`, `createVersionAndChunks` (transactional), `softDeleteVersion`, `listVersions`, `getVersionOwned`, `listChunksForVersion`, `enforceQuota` (sums `size_bytes` over non-deleted versions across all user's backups; throws `STORAGE_QUOTA_EXCEEDED` if + new size > limit), `enforceVersionRetention` (soft-deletes oldest beyond the 5-most-recent for a backup).
- [ ] 2.4 `src/lib/hosted-backup/subscriptions.ts` — `applyPaddleEvent(event)` mapping per contract §10. Note Paddle spelling `subscription.canceled` (one l) is mapped to internal `cancelled` (two l's). Idempotency check at the webhook layer; the function is itself idempotent on `paddle_subscription_id` upsert. `cancelPaddleSubscription(paddleSubscriptionId)` calls Paddle's PATCH `/subscriptions/:id/cancel` (best-effort).
- [ ] 2.5 Update `src/lib/hosted-backup/db.ts` — replace the stubbed `getSubscriptionStatus` with `SELECT status FROM subscriptions WHERE user_id = $1` (returns `'none'` if no row). Add `upsertSubscription`, `markPaddleEventProcessed`, `findPaddleEventById`, `getSubscriptionByPaddleId`.
- [ ] 2.6 `src/lib/hosted-backup/account-deletion.ts` — `deleteAccount(userId)`: in a single transaction, write audit-log row (with `userIdHash = SHA-256(userId)`); attempt Paddle cancel (log + continue on failure — "email failure must not 500" pattern from license webhook); cascade-delete subscriptions, refresh_tokens, backup_chunks (via FK), backup_versions, backups, auth_credentials, users. R2 prefix marked for async purge by writing a row to a deletion queue (or a TODO log; see design.md).

## 3. Routes

All routes wrap responses with `withApiVersion` and use `requireAuth` (except the webhook). All ownership checks return 404 (not 403) per contract §7.

- [ ] 3.1 `src/app/api/backups/route.ts` — `GET` (list user's backups: `{ backups: [{ id, name, latestVersionId, versionCount, totalSize, updatedAt }] }`); `POST { name }` → `{ backupId }`. `POST` requires `active`.
- [ ] 3.2 `src/app/api/backups/[backupId]/route.ts` — `DELETE`. Hard-deletes the backup row (FKs cascade to versions + chunks). Marks R2 prefix for async purge. Allowed in `active`, `grace`, `cancelled`.
- [ ] 3.3 `src/app/api/backups/[backupId]/versions/route.ts` — `GET` (versions list); `POST { encryptedManifest, chunkMetadata: [{ index, encryptedSize, sha256 }] }`. POST: validate quota; mint per-chunk presigned PUTs (5-min TTL); insert `backup_versions` + `backup_chunks` rows in a transaction; enforce 5-version retention (soft-delete oldest); return `{ versionId, uploadUrls: [{ chunkIndex, presignedUrl, expiresAt }] }`. POST requires `active`.
- [ ] 3.4 `src/app/api/backups/[backupId]/versions/[versionId]/route.ts` — `DELETE` (soft-delete, sets `deleted_at`). Allowed in `active`, `grace`, `cancelled`.
- [ ] 3.5 `src/app/api/backups/[backupId]/versions/[versionId]/download-urls/route.ts` — `POST { chunkIndices: number[] }` → `{ urls: [{ chunkIndex, presignedUrl, expiresAt }] }`. Allowed in `active`, `grace`, `cancelled`.
- [ ] 3.6 `src/app/api/webhooks/paddle/route.ts` — adapts `src/app/api/license/webhook/route.ts`. Imports `verifyPaddleSignature` from `src/lib/license/paddle.ts` verbatim. Idempotency check against `paddle_webhook_events` (insert event_id; if `INSERT ... ON CONFLICT DO NOTHING` returns no rowCount, return 200 dedup). Maps event types per contract §10. Returns 2xx for any recognised or ignored event. `runtime: 'nodejs'`.
- [ ] 3.7 `src/app/api/account/route.ts` — `DELETE`, auth-gated. Calls `deleteAccount(userId)`. Returns `{ ok: true }`.
- [ ] 3.8 `src/app/api/cron/backup-gc/route.ts` — stub. Returns `{ ok: true, todo: 'cron schedule wiring deferred' }`. Comment block lays out the intended query: `SELECT id, manifest_object_key FROM backup_versions WHERE deleted_at < now() - interval '7 days'` plus join to `backup_chunks` for chunk object keys; deletes from R2 by object key, then deletes the rows.

## 4. Subscription gating helper

- [ ] 4.1 `src/lib/hosted-backup/auth-middleware.ts` — add `requireWriteAccess(req)` and `requireReadAccess(req)`. Both call `requireAuth` first, then check `subscriptionStatus`: write requires `active` (throws `SUBSCRIPTION_REQUIRED` 402); read requires `active` OR `grace` OR `cancelled` (throws `SUBSCRIPTION_REQUIRED` 402 if `none`). Re-fetch from DB rather than trust JWT claim (claim is a hint per contract §10).

## 5. Tests

- [ ] 5.1 `src/lib/hosted-backup/__tests__/storage.test.ts` — quota enforcement (under, exactly at, over); ownership returns null on cross-user; version retention soft-deletes oldest beyond 5; soft-delete preserves row.
- [ ] 5.2 `src/lib/hosted-backup/__tests__/r2.test.ts` — `presignPut` and `presignGet` produce signed URLs scoped to the right object key with 5-minute TTL. Mock the S3 client.
- [ ] 5.3 `src/lib/hosted-backup/__tests__/subscriptions.test.ts` — state-machine transitions for each event type per contract §10; Paddle's `canceled` (one l) maps to internal `cancelled` (two l's).
- [ ] 5.4 `src/lib/hosted-backup/__tests__/paddle-webhook.test.ts` — valid signature processed; invalid signature 401; tampered body 401; missing header 401; idempotency (same `event_id` twice → 200 + dedup); unknown event type → 200 (logged).
- [ ] 5.5 `src/lib/hosted-backup/__tests__/account-deletion.test.ts` — full cascade across all six tables in dependency order; audit-log row written; Paddle-cancel failure tolerated.
- [ ] 5.6 `src/lib/hosted-backup/__tests__/subscription-gating.test.ts` — write blocked in `grace`/`cancelled`/`none`; read allowed in `active`/`grace`/`cancelled`, blocked in `none`.

## 6. Docs + Env

- [ ] 6.1 README — append R2 setup section to "Hosted Backup": describe how to set R2 env vars from a Cloudflare R2 access token + bucket.
- [ ] 6.2 `.env.example` — add `R2_*` vars and `HOSTED_BACKUP_QUOTA_BYTES`. (Note: writing this file may be blocked by permission settings; if so, update README to list them.)

## 7. Verification

- [ ] 7.1 `npm run openspec:validate` passes strict.
- [ ] 7.2 `npm run build` succeeds.
- [ ] 7.3 `npm test` — every test passes (PR1 + new suites).
- [ ] 7.4 Local smoke (after migrations + R2 creds): signup → login → `POST /api/backups` blocked with `SUBSCRIPTION_REQUIRED` (status `none`); manually flip subscription row to `active`; create backup → create version (returns presigned URLs) → list versions → request download URLs.
- [ ] 7.5 Local smoke: simulate a Paddle webhook with a known `event_id`; verify subscription row appears; replay same event; verify dedup.
- [ ] 7.6 Local smoke: `DELETE /api/account` removes all rows for the user; audit row appears with `userIdHash = SHA-256(userId)`.

## 8. Release

- [ ] 8.1 Commit on `feat/hosted-backup-storage-subs`: `feat(hosted-backup): add R2 storage, Paddle subscription state machine, GDPR account deletion`.
- [ ] 8.2 Hugo reviews diff before push.
- [ ] 8.3 Push; lefthook pre-push runs `openspec validate --all --strict`.
- [ ] 8.4 Open PR after PR1 merges to main; rebase if needed.
- [ ] 8.5 Post-merge: deploy, run `npm run migrate` (applies 0005-0010).
- [ ] 8.6 Archive: `npx openspec archive add-hosted-backup-storage-and-subscriptions`.
