# Tasks — harden-hosted-backup-operations

## 1. Cron scheduling

- [x] 1.1 Add `vercel.json` with daily crons: `/api/cron/claim-followups` at
  `0 12 * * *`, `/api/cron/backup-gc` at `17 3 * * *`.
- [x] 1.2 Extract `verifyCronAuth` into `src/lib/hosted-backup/cron-auth.ts`
  (fail-closed when `CRON_SECRET` unset); reuse it from
  `claim-followups/route.ts`.
- [x] 1.3 Document `CRON_SECRET` (generate, install in Vercel, verify) in
  `docs/runbooks/production-keys-and-storage.md`.

## 2. Schema

- [x] 2.1 Migration `0016_gc_and_rate_limits.sql`: `r2_purge_queue` table
  (partial index on pending rows), `rate_limit_events` table (index on
  `(scope, key, at)`), `backup_versions.manifest_seen_at timestamptz` column.

## 3. Purge enqueue on hard deletes

- [x] 3.1 `db.ts`: rewrite `deleteBackupOwned` as a single CTE statement that
  deletes and enqueues `users/<userId>/backups/<backupId>/` if-and-only-if a
  row was removed.
- [x] 3.2 `db.ts`: rewrite `deleteUserCascade` as a single CTE statement that
  deletes the user and enqueues `users/<userId>/`.
- [x] 3.3 Confirm `storage.ts deleteBackup` / `account-deletion.ts` keep their
  response shapes unchanged.

## 4. backup-gc implementation

- [x] 4.1 `r2.ts`: add `headObjectExists` (404-aware tri-state),
  `listObjectKeys` (paginated), `deleteObjects` (≤1000-key batches).
- [x] 4.2 `db.ts`: add GC queries — `findExpiredDeletedVersions`,
  `hardDeleteVersion`, `findPendingPurges`, `markPurgeDone`,
  `findUncheckedManifestVersions`, `stampManifestSeen`,
  `softDeleteVersionById`, `deleteRateLimitEventsBefore`.
- [x] 4.3 Implement `src/app/api/cron/backup-gc/route.ts`: cron auth + Pass A
  (expired soft-deletes: R2 delete → hard-delete rows), Pass B (purge-queue
  drain, mark only when prefix empty), Pass C (abandoned-upload sweep via
  `manifest_seen_at`), Pass D (rate-limit prune); per-pass caps and counts
  summary.

## 5. Rate limiting

- [x] 5.1 `src/lib/hosted-backup/rate-limit.ts`: `enforceRateLimit` +
  `recordRateLimitEvent` + `clientIpFrom`.
- [x] 5.2 Wire `login` (per-IP all-checked-first; per-account on step 2;
  record on `EMAIL_NOT_FOUND` / `INVALID_CREDENTIALS` only).
- [x] 5.3 Wire `recover` (per-IP + per-account; record on
  `INVALID_RECOVERY_KEY`).
- [x] 5.4 Wire `signup` (per-IP; record every shape-valid attempt).

## 6. Tests (node:test, module mocks)

- [x] 6.1 `cron-auth.test.ts`: bearer accepted, wrong/missing rejected,
  unset secret fails closed.
- [x] 6.2 `backup-gc.test.ts`: Pass A R2-before-DB ordering (rows survive R2
  failure), idempotent re-run, caps respected; Pass B marks only when empty;
  Pass C 404→soft-delete, 200→stamp, transport-error→no-op.
- [x] 6.3 `rate-limit.test.ts`: under/over threshold, per-key isolation,
  window expiry, failure-only recording for login.
- [x] 6.4 `account-deletion.test.ts` unchanged (enqueue lives inside the CTE in `db.ts`, below the mocked seam); covered by the SQL itself + live check 7.3 for the enqueue-on-cascade
  contract.

## 7. Verification

- [x] 7.1 `npm test` and `npm run openspec:validate` green.
- [ ] 7.2 Post-deploy: crons visible in Vercel dashboard; manual
  `curl -H "Authorization: Bearer $CRON_SECRET"` hits both routes (200) and a
  secretless hit returns 401.
- [ ] 7.3 Live GC seed check: delete a test backup → queue row → next run
  purges prefix and stamps `purged_at`.
- [ ] 7.4 Live rate-limit check: 11 bad logins on a test account → 429
  `RATE_LIMITED`.
