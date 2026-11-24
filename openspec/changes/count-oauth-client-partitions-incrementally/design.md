## Context

`exomem_oauth_client_partitions()` (migrations 0067 and 0088) counts unretired clients through a `CASE` over `admission_mode`, `auto_registered` and `client_platform`. The planner cannot use that `CASE` as an index condition, so every check reads every unretired row. Measured on generated data with PostgreSQL 16: each check costs 50–57 ms at 500,000 clients per partition, and the operator headroom report costs 157 ms.

## Decision: a maintained counter, not a narrower count

Each partition's row in `exomem_oauth_client_partition_bounds` gains a `used` column that triggers keep. The check is a primary-key read.

The alternative was to narrow each count so that the partial index serves it, for example `admission_mode = 'generic'` for the generic partition. It costs 24–27 ms at 500,000 clients, still grows with the population, and leaves the race. The counter costs under 1 ms at any population.

## Keeping the counter exact

- The triggers are statement-level and read transition tables. Each sums the statement's net change per partition and writes only the partitions that changed. An update that moves no client into or out of a partition takes no counter lock.
- `INSERT … ON CONFLICT DO UPDATE` fires the insert trigger for new rows and the update trigger for revived rows.
- A truncate zeroes the counters.
- Counter rows lock in partition-name order, so two transactions that move clients between the same partitions cannot deadlock.

## The check

`exomem_oauth_client_partition_available_for` returns true when the row already holds a slot in the target partition. Otherwise it locks the target's counter row with `FOR UPDATE`, together with the partition that the row would leave, and compares `used` with `bound`. The lock lasts until the registration commits, and the registration's own trigger counts the new client under it. A concurrent registration waits, then reads the new count.

Lock order holds across every writer that changes a partition:

- Generic registration inserts only fresh identifiers, so it never waits on a client row.
- CIMD registration, operator registration and the retirement sweep are ordered by the cohort advisory lock. The sweep takes it exclusively.

## Drift

Drift can come only from a write that bypasses the triggers: `session_replication_role = replica`, a restore with triggers disabled, or a bounds row added by hand. `exomem_oauth_client_partition_recount` locks the counter row with `SKIP LOCKED`, then counts in a new statement. A writer that has not committed waits on the row and applies its change after the recount, so the result is exact.

The recount reads every unretired client through the partial index `exomem_oauth_clients_unretired_partition_idx`. It took 67–89 ms with 500,000 unretired clients in each of two partitions. Its cost is capped by the bounds, not by the retired rows that accumulate. A registration in the partition waits behind it, so the sweep recounts each partition once an hour, not on every run, and reports the drift it corrected.

A bounds row that an operator adds has no count (`used` is NULL). Its partition admits no new client, and the headroom report refuses to read, until the next sweep recounts it.
