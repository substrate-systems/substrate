## 1. Counter

- [x] 1.1 Define the partition rule once in `exomem_oauth_client_partition_of` (migration 0093).
- [x] 1.2 Add `used` and `recounted_at` to `exomem_oauth_client_partition_bounds`. Keep `used` with statement-level insert, update, delete and truncate triggers, and backfill it in the migration.
- [x] 1.3 Read the counter in `exomem_oauth_client_partitions()` and lock it in the partition checks, keeping their signatures.
- [x] 1.4 Drop the generic registration advisory lock.

## 2. Drift

- [x] 2.1 Add `exomem_oauth_client_partition_recount`. The OAuth sweep calls it hourly per partition and reports the drift.

## 3. Proof

- [x] 3.1 Test that two connectors racing for the last slot take one slot. The test fails on the previous release.
- [x] 3.2 Test that the counters stay exact through concurrent registration, revival, moves, retirement and deletion.
- [x] 3.3 Measure the checks before and after at 500,000 clients per partition.

## 4. Operations

- [x] 4.1 Update the operator runbook: the counters, the recount, and when to run it by hand.
- [ ] 4.2 After the release, confirm that the deployed counters equal an exact count.
