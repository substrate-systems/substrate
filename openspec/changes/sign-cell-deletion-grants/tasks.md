The packets match the paired Exomem change `automate-cell-storage-deletion`
(task 2.1). This file holds the whole Substrate side.

## 1. Columns, grants and triggers

- [x] 1.1 Add migration 0084 with `deletion_grant` and `deletion_stopped_at`,
  the live-cell CHECK, the finality trigger and the stop-time trigger, and
  backfill `deletion_stopped_at` for rows already deleted on both sides. Give
  substrate_app `UPDATE (deletion_grant)` in `scripts/exomem-cloud-grants.sql`,
  guarded on the column. Verify: disposable PostgreSQL tests for each grant,
  the CHECK and both triggers.

## 2. Signing and recording

- [x] 2.1 Add `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY` through a shared
  Ed25519 loader in `cloud-config.ts`, let `signCloudJwt` take a null
  lifetime, and add `cloud-deletion-grants.ts` (`signCloudDeletionGrant`,
  `recordCellDeletionGrant`, `readCellDeletionSet`,
  `backfillCellDeletionGrants`). Call `recordCellDeletionGrant` in the
  transactions of `reconcileCloudCellDesiredState` and
  `expireCloudCellAtomic`. Verify: the signed grant passes the shared fixture,
  and a deletion with no key stores no grant.

## 3. The deletion set and the backfill

- [x] 3.1 Add `GET /api/exomem/cell-deletions/[token]`, key-watcher capability
  only, and `scripts/backfill-cell-deletion-grants.ts`, dry run by default.
  Copy `contracts/cell-deletion-grants-v1.json` byte-identical from Exomem and
  add the drift check. Verify: the endpoint refuses the scheduler capability
  and returns every cell deleted with a grant, and the backfill's dry run
  writes nothing.
- [ ] 3.2 Run the backfill at the Exomem rollout's step 10, after the
  rehearsal, with operator approval: dry run first, then `--commit`. Verify:
  the deletion-set endpoint lists every deleted cell.

## 4. Delivery

- [x] 4.1 Update `docs/runbooks/exomem-cloud-operations.md`: the new key, the
  deletion-set endpoint and the backfill procedure. Verify: the env table
  names both production-only signing keys.
