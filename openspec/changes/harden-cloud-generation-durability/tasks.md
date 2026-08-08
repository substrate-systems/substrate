## 1. Schema

- [x] 1.1 Add migration `0038_backup_version_commit.sql`: `committed_at`,
      `requires_commit`, partial indexes for the visibility predicate and the
      uncommitted-reclaim scan
- [x] 1.2 Backfill `committed_at = created_at` for every existing row so no
      subscriber's history disappears under the new predicate

## 2. Version visibility (db.ts — single SQL owner)

- [x] 2.1 Apply `(requires_commit = false OR committed_at IS NOT NULL)` in
      `listVersions`
- [x] 2.2 Apply it in `listBackupsForUser`, including `latest_version_id`,
      `version_count` and `total_size`
- [x] 2.3 Apply it in `sumActiveStorageForUser` and `getUserBackupStats`
- [x] 2.4 Apply it in `softDeleteVersionsBeyondRetention` so retention ranks
      and evicts only visible versions
- [x] 2.5 Leave `getVersionOwned` unfiltered (commit must resolve a
      not-yet-visible version) and document why
- [x] 2.6 Add `commitVersion` — ownership-scoped, idempotent by pre-image
- [x] 2.7 Add `requiresCommit` to `insertVersionWithChunks`

## 3. Two-phase push

- [x] 3.1 Add `clientRequiresVersionCommit` to `api-version.ts`, failing
      closed on absent/malformed/older headers
- [x] 3.2 `createVersionWithUploads`: accept `requiresCommit`, stop pruning
      retention on the 2.1 path, keep the create-time prune on the 2.0 path
- [x] 3.3 Add `commitVersionUpload` to `storage.ts` — commit, then prune, and
      only when this call performed the commit
- [x] 3.4 Add `POST /api/backups/[backupId]/versions/[versionId]/commit`
      using `requireWriteAccess` and the standard error envelope
- [x] 3.5 Negotiate `requiresCommit` from the request header in
      `POST /api/backups/[backupId]/versions` and return it
- [x] 3.6 Bump `SchemaVersion` to `2.1`; add `CommitVersionResponse`

## 4. Garbage collection

- [x] 4.1 Add `findStaleUncommittedVersions` (hours-scale window)
- [x] 4.2 Add GC Pass F: delete R2 objects then hard-delete the row, bounded
      per run, R2-before-DB
- [x] 4.3 Add `expireCancelledSubscriptions` — delete backups, enqueue the R2
      prefix on `r2_purge_queue`, downgrade status to `none`, all in one
      statement
- [x] 4.4 Add GC Pass G and report both passes in the outcome counters
- [x] 4.5 Leave Passes A–E unchanged

## 5. Lifecycle honesty

- [x] 5.1 `GRACE_WINDOW_DAYS` 14 → 30
- [x] 5.2 Add `CANCELLED_RETENTION_DAYS = 30`
- [x] 5.3 Apply the `cancelled → none` cutoff at read time in
      `getSubscriptionStatus` and `getSubscriptionEntitlement`
- [x] 5.4 Update the stale 14-day comments in `auth-middleware.ts` and
      `api/account/me`

## 6. Tests

- [x] 6.1 Real-Postgres integration suite over migrations 0001→0038 via a
      `__setHostedBackupSqlForTests` seam: backfill, visibility, quota,
      summaries, idempotency, ownership, retention, stale-version selection,
      both lifecycle windows, and the purge
- [x] 6.2 Storage-layer suite: header negotiation matrix, 2.1 vs 2.0 create
      behaviour, commit publishes and prunes once, replay prunes nothing,
      failed push evicts nothing, cross-user is NOT_FOUND
- [x] 6.3 Route suite: commit 200 / replay / 404 / write-gate, and header
      pass-through on version create
- [x] 6.4 Extend `backup-gc.test.ts` with Pass F and Pass G

## 7. Contract and CI

- [x] 7.1 Replace the stale Schema 1.0 copy with the canonical 2.0 document
- [x] 7.2 Apply 2.1 additions: §7 commit endpoint, §8 versioning model and
      reclamation, §10 windows and purge timeline, §11 negotiation, changelog
- [x] 7.3 Add `.github/workflows/ci.yml` (lint, test, build, openspec)
- [x] 7.4 Run the new Postgres suite in `test.yml` against the pg service

## 8. Verification

- [x] 8.1 `npm run lint`
- [x] 8.2 `npm test`
- [x] 8.3 `npm run build`
- [x] 8.4 `npm run openspec:validate`
