# Sign cell deletion grants

## Why

Exomem's `automate-cell-storage-deletion` automates the purge of a deleted
cell's backups and media. Its executors act only on a deletion grant that
Substrate signs, and its key watcher reads the deletion set from a Substrate
endpoint. Today Substrate signs nothing when it deletes a cell, so nothing can
purge, and the watcher has no set to read.

## What changes

- A `deletion_grant` column and a `deletion_stopped_at` column on
  `exomem_cloud_cells` (migration 0084). cellctl reads the grant and cannot
  write it; only the trigger writes the stop time.
- The database refuses any change to a deleted cell's desired state, for every
  role, and refuses a grant on a live cell.
- A new signing key, `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY`, apart from the
  operation grant key, so the operator turns purges on independently. Unset, a
  deletion still succeeds and stores no grant.
- Substrate signs the grant in the transaction that deletes the cell. The
  grant is an Ed25519 JWT with exactly `aud`, `iat`, `jti`, `cell_id` and
  `purge_after`; it carries no `exp`, because a deletion is final.
- A deletion-set endpoint, `GET /api/exomem/cell-deletions/<capability>`, that
  answers only the key-watcher receiver capability.
- A backfill script signs the grants of cells deleted before the key went
  live. It runs at the Exomem rollout's step 10, after the rehearsal, with
  operator approval.

## Decision

The grant has no expiry and a fixed seven-day grace, `purge_after = iat + G`,
with `G` living once in Substrate's configuration. The stop time uses the
database clock at the moment cellctl's deleted report lands, never a
cellctl-written time. The deletion set reports each grant's own claims, so the
endpoint and the executors read one source.

## Non-goals

- The Exomem side: cellctl's relay, the executors and the watcher's states are
  the paired change `automate-cell-storage-deletion`.
- Deleting or restoring a deleted cell's row. The finality trigger governs
  `desired_state` only.

## Capabilities

### Modified Capabilities

- `exomem-tenant-control-plane`: the deletion grant, deletion finality and the
  deletion set the watcher reads.

## Impact

Migration 0084, the grants script, `cloud-deletion-grants.ts`, the deletion-set
route, the backfill script, the shared fixture `contracts/cell-deletion-grants-v1.json`
and the runbook. The drift workflow fails on a fixture difference only after
the Exomem PR merges and publishes the contract on `main`.
