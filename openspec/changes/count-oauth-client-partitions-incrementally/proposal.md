## Why

Every OAuth client registration checks its population partition by counting the partition's unretired clients. The count reads every unretired client row, so its cost grows with the population. At 500,000 clients per partition, the size the 10,000-tenant load target needs, one check costs about 55 ms vacuumed and up to 160 ms otherwise. Generic registrations also queue behind each other's count. The operator therefore cannot raise the `generic` and `auto_registered` bounds above their 50,000 launch defaults.

The check also races. Connector (CIMD) registrations run concurrently, and each counts without seeing the others' uncommitted rows. Two registrations that arrive at the last free slot can both take it.

## What Changes

- Each partition's bounds row carries its count of unretired clients. Statement-level triggers on `exomem_oauth_clients` keep it for every insert, update, delete and truncate. The migration backfills it.
- The partition check reads that one row and locks it until the registration commits. Concurrent registrations then never pass the bound, and the check costs the same at any population.
- The OAuth sweep recounts each partition exactly once an hour and reports the drift it corrected. Non-zero drift means a write bypassed the triggers.
- The generic registration path drops its global advisory lock. The partition row lock now serialises it.
- The partition rule lives in one SQL function, `exomem_oauth_client_partition_of`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-mcp-oauth`: the client population check stays constant-cost and exact under concurrent registration.

## Impact

- Migration 0093. It adds two columns and four triggers, and replaces the partition functions with unchanged signatures, so an instance still on the previous release keeps working during the deploy.
- `src/lib/exomem-hosted/oauth-store.ts`: generic registration and the sweep. The cron route reports the recount.
- Operator runbook: the counters, the recount, and raising a bound.
- Raising the bounds to 500,000 stays a separate operator data write.
