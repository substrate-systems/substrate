# Change: Harden Endstate Cloud generation durability

## Why

`POST /api/backups/:id/versions` treats *creating* a version as *completing*
one. The `backup_versions` row is inserted and retention is pruned before a
single byte reaches R2, and there is no endpoint that says "the upload
finished". Four user-visible failures follow from that one gap:

- A push that dies mid-upload leaves a version that lists as a restore target.
  Restoring it hands the user a backup whose chunks are not there.
- The same failed push has already soft-deleted the sixth-newest version — so
  a failed backup destroys a good one.
- The phantom counts against the 1 GiB quota and against
  `versionCount` / `totalSize`, so a subscriber pays for bytes that were never
  stored.
- GC cannot reconcile it: Pass C only HEADs the *manifest*, only after 48
  hours, and clients upload the manifest first — so the common
  manifest-present/chunks-missing shape is invisible to it forever.

Two lifecycle promises are also untrue in code. `GRACE_WINDOW_DAYS` is 14
while the published contract §10 and the public Terms both say 30, cutting
paying customers off two weeks early. And `cancel_started_at` is written by
the Paddle webhook but read by no query and acted on by no job, so the Terms
sentence "retained for 30 days to allow reactivation, then permanently
deleted" describes something that does not happen: cancelled subscribers keep
read access indefinitely and their blobs are never purged.

## What Changes

- Add a two-phase version push: `POST /api/backups/:id/versions/:vid/commit`
  publishes a version. Until committed, a version is invisible to listings,
  backup summaries, quota, and restore, and holds no retention slot.
- Negotiate the behaviour per request from the caller's
  `X-Endstate-API-Version` header. Schema 2.1+ gets the commit gate; schema
  2.0 and any client that sends no header keep today's behaviour verbatim.
- Move retention pruning from version creation to version commit, so the
  destructive step only runs once the replacement provably exists.
- Add a GC pass that reclaims never-committed versions (and their R2 objects)
  a few hours after creation — the sweep that finally sees
  manifest-present/chunks-missing.
- Correct `GRACE_WINDOW_DAYS` from 14 to 30 to match the contract and Terms.
- Implement `cancelled → none` from `cancel_started_at`, plus a GC pass that
  deletes the data and enqueues the R2 prefix on the existing purge queue
  after the 30-day window. The account row survives; only data is purged.
- Replace the repo's stale Schema 1.0 contract copy with the canonical 2.0
  document and apply the 2.1 additions. Bump `SchemaVersion` to `2.1`.
- Add `.github/workflows/ci.yml` — this repo had no lint/build/spec gate.

No behaviour is removed and no field is re-typed, so this is additive per
contract §13. Migration 0038 backfills every existing version as committed,
so no current subscriber's backup history disappears.

## Impact

- Affected specs: `hosted-backup-operations`
- Affected code:
  - `migrations/0038_backup_version_commit.sql`
  - `src/lib/hosted-backup/db.ts` (visibility predicate, `commitVersion`,
    `findStaleUncommittedVersions`, `expireCancelledSubscriptions`,
    `GRACE_WINDOW_DAYS`, `CANCELLED_RETENTION_DAYS`)
  - `src/lib/hosted-backup/storage.ts` (`createVersionWithUploads`,
    `commitVersionUpload`)
  - `src/lib/hosted-backup/api-version.ts` (`clientRequiresVersionCommit`)
  - `src/lib/hosted-backup/types.ts` (`SchemaVersion`, response shapes)
  - `src/app/api/backups/[backupId]/versions/route.ts`
  - `src/app/api/backups/[backupId]/versions/[versionId]/commit/route.ts`
  - `src/app/api/cron/backup-gc/route.ts` (Pass F, Pass G)
  - `hosted-backup-contract.md`, `.github/workflows/`
