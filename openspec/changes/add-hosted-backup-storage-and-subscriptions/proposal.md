## Why

PR1 (`add-hosted-backup-auth`) shipped the auth foundation: users, JWTs, OIDC discovery, JWKS, refresh-token rotation. It deliberately stubbed `getSubscriptionStatus` to `'none'` because the subscription table didn't exist and the storage routes that consume that status weren't yet built. This change closes that gap.

It adds the rest of the substrate-side hosted-backup surface in a single coherent unit: encrypted backup metadata + R2 presigned URLs + the Paddle subscription state machine + GDPR account deletion. These are split into three OpenSpec capabilities because they're conceptually distinct, but they ship together because every storage route needs subscription gating, the JWT `subscription_status` claim needs a real source, and account deletion cascades into both the storage and subscription tables. Splitting storage and subscriptions into separate PRs would create a meaningless intermediate state where storage exists but isn't paywall-gated.

The full protocol is locked in `hosted-backup-contract.md` (root). This change implements §7 (API surface for backups + account), §8 (R2 layout, quota, retention), §10 (subscription state machine + Paddle event mapping), and §12 (GDPR deletion).

## What Changes

- New tables: `backups`, `backup_versions`, `backup_chunks`, `subscriptions`, `paddle_webhook_events`, `audit_log_account_deletions`. Migrations `0005_*` through `0010_*`.
- New `src/lib/hosted-backup/r2.ts`: lazy S3 client (R2 endpoint), `presignPut`, `presignGet`, 5-minute TTL.
- New `src/lib/hosted-backup/storage.ts`: `createBackup`, `listBackupsForUser`, `getBackupOwned` (returns null for not-found OR not-owned per contract §7), `createVersion`, `softDeleteVersion`, `listVersions`, `enforceQuota`, `enforceVersionRetention`.
- New `src/lib/hosted-backup/subscriptions.ts`: `applyPaddleEvent` (state machine per contract §10), `cancelPaddleSubscription` (Paddle API wrapper). Replaces PR1's `getSubscriptionStatus` stub in `db.ts` with a real query against the new `subscriptions` table.
- New `src/lib/hosted-backup/account-deletion.ts`: `deleteAccount(userId)` — best-effort Paddle cancel, audit-log row, transactional cascade delete across users + auth_credentials + refresh_tokens + subscriptions + backups + backup_versions + backup_chunks. R2 prefix marked for async deletion.
- New routes:
  - `GET /api/backups`, `POST /api/backups`
  - `DELETE /api/backups/:backupId`
  - `GET /api/backups/:backupId/versions`, `POST /api/backups/:backupId/versions`
  - `DELETE /api/backups/:backupId/versions/:versionId`
  - `POST /api/backups/:backupId/versions/:versionId/download-urls`
  - `POST /api/webhooks/paddle` — adapts `src/app/api/license/webhook/route.ts`, reuses `verifyPaddleSignature` verbatim
  - `DELETE /api/account`
  - `GET /api/cron/backup-gc` — stub for the deferred R2 garbage-collection cron
- Subscription gating: write paths (`POST /api/backups`, `POST .../versions`) require `active`; read paths (`GET .../versions`, `POST .../download-urls`) allow `active`, `grace`, `cancelled` per contract §10.
- New env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`, `HOSTED_BACKUP_QUOTA_BYTES` (optional, defaults to 1 GiB). `PADDLE_WEBHOOK_SECRET` and `PADDLE_API_KEY` already exist from the license module — reused verbatim.
- New runtime dependencies: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- README updated with R2 setup section.

## Capabilities

### New Capabilities

- `hosted-backup-storage`: backup metadata CRUD, version create with per-chunk presigned PUT URLs, soft-delete with 7-day GC window, quota enforcement at version creation, ownership 404, version retention (5 per backup).
- `hosted-backup-subscriptions`: state machine (`none`/`active`/`grace`/`cancelled`), Paddle webhook signature verification + idempotency + event mapping, write/read gating per state, JWT `subscription_status` claim sourced from the real subscriptions row.
- `hosted-backup-account-deletion`: `DELETE /api/account` synchronous Postgres cascade, best-effort Paddle subscription cancel, audit-log row keyed by `SHA-256(userId)`, R2 prefix marked for async purge.

### Modified Capabilities

<!-- None — the PR1 capabilities continue to behave per their existing specs.
     `subscriptionStatus` was already specified as one of the four locked
     values; PR1 stub returned `none`, this PR makes it real, but the
     observable behavior at the spec level is unchanged. -->

## Impact

- Six new tables; six new SQL migrations.
- Eight new API routes (six under `/api/backups/`, plus webhook + delete + cron stub).
- Four new library files; one library function (`getSubscriptionStatus`) gains a real implementation.
- Two new dependencies (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
- Six new env vars (R2 + optional quota override).
- README "Hosted Backup" section appended with R2 setup notes.
- Existing license routes, license library, and PR1 hosted-backup auth code: untouched.
