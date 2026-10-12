## 1. Retirement state

- [x] 1.1 Migration: add `retired_at timestamptz` to `exomem_oauth_clients`, defaulting to NULL
  - `migrations/0067_exomem_oauth_client_slot_reclaim.sql`. A check constraint keeps a retired client disabled and refuses to retire the first-party client.
- [x] 1.2 Count only `retired_at IS NULL` rows in `exomem_oauth_client_partition_available`, keeping the provenance partition and both bounds as they are
  - The three partitions and their counts now live in one function, `exomem_oauth_client_partitions()`, which reads each bound from `exomem_oauth_client_partition_bounds` (1.4). Both gate functions and the headroom report read it.
  - The existing-client shortcut now matches unretired rows only, so a retired client needs a free slot to come back.
- [x] 1.3 Index review: the partition predicate runs on every admission, so measure it before and after rather than assuming the added condition is free
  - Measured on PostgreSQL 16 with 350 clients near the old bounds. Before: a sequential scan of 12 buffers. After: a primary-key read of the bounds table and an index-only scan of the new partial index `exomem_oauth_clients_unretired_partition_idx`, 6 buffers in all. With 20,000 retired rows added, the count still reads 2 buffers; without the index it reads 760. With both self-registering partitions at 49,999 live clients, one below their launch bound of 50,000, and 40,000 retired rows, each gate call takes 5.5 to 5.9 ms and reads 85 to 88 buffers. The count reads every unretired index entry and filters by partition, so its cost grows with all unretired clients, not with retired history.
- [x] 1.4 Keep each partition's bound as data, and size the launch bounds so that normal growth never reaches them
  - `exomem_oauth_client_partition_bounds`, seeded by 0067: operator 96, auto-registered 50,000, generic 50,000. One UPDATE changes a bound. A partition without a row admits no new client.

## 2. Automatic retirement

- [x] 2.1 Retire an expired CIMD client in `pruneExpiredOAuthState`, after a grace period well beyond `CIMD_MAX_TTL_SECONDS`
  - Auto-registered clients only. An operator-registered CIMD client stays in the operator's hands. A connector that held a grant waits `EXOMEM_OAUTH_LAPSED_CONNECTOR_GRACE_HOURS` after its metadata expired, default 336 (twice the longest metadata lifetime). One that never held a grant waits `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS` after its last registration, default 24.
  - The sweep no longer resets `metadata_expires_at` to the time of each run, which would have restarted the grace on every run. It disables an expired client once and keeps the expiry the metadata stated.
- [ ] 2.2 Retire a reviewer bootstrap client on the same transition that consumes or revokes its authority
  - Not done: retiring the Hosted platform removed every path that creates, consumes or revokes a bootstrap authority, so no such transition exists. Every bootstrap client that will ever exist already exists. Section 5 retires them as an operator step.
- [x] 2.3 Refuse retirement for any client that is enabled or holds a live grant, access token, or refresh token — a query, not an age heuristic
  - The view `exomem_oauth_clients_holding_live_authority`: a grant that is not revoked, an unexpired code, access token or refresh token, or an authorization in progress. The sweep anti-joins it; `exomem_oauth_client_holds_live_authority(client)` reads it for one client. A grant that is not revoked counts even without tokens, because Home lists it as a connected app.
- [x] 2.4 Confirm the existing `ON CONFLICT (client_id) DO UPDATE` path revives a retired row rather than consuming a second slot
  - The upsert clears `retired_at` and reuses the row. Reviving takes one free slot: a retired row holds none, so a full partition refuses the returning client like a new one.
- [x] 2.5 Retire a generic client that has held no live authority for a grace period, disabling it in the same write
  - The grace is `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS`, default 24, counted from registration and from the last creation, renewal or revocation of any of its grants. Nothing revives a retired generic client.
- [x] 2.6 Give `pruneExpiredOAuthState` a production caller
  - `/api/cron/exomem-reconcile` runs it every minute beside the billing and Cloud lanes. It retires at most 100 clients per partition per run. A failure answers `503` after the other lanes finish.
  - The deletes run outside the cohort lock, one statement each, grants unlinked first. Only disable and retire hold the lock. Four foreign-key indexes make each delete's actions index lookups: on a table of 120,000 refresh tokens, the refresh and family deletes took 3.2 s and 3.5 s without them and 48 ms and 20 ms with them.
- [x] 2.7 Answer `invalid_client` at the token endpoint for an unknown or retired client
  - Checked only after a refusal, so a successful exchange pays nothing. Both cases answer alike. No code in either repository keys on `invalid_grant` for an unknown client.
- [x] 2.8 Refuse the operator enable action for a retired client

## 3. Visibility

- [x] 3.1 Report per-partition headroom as content-free operator state
  - `GET /api/exomem/admin/oauth-clients` returns `headroom` with `bound`, `used` and `free` for each partition, read from `exomem_oauth_client_partitions()`.
- [ ] 3.2 Make `scripts/reviewer_bootstrap.py` in the `exomem` repository read that headroom instead of comparing against its hardcoded `OPERATOR_CLIENT_BOUND`, which `0051` already made stale
- [x] 3.3 Runbook: retirement rules, grace settings, what a client sees after retirement, and the generic lane's enable condition
  - `docs/runbooks/exomem-cloud-operations.md`, "Client slots and retirement".

## 4. Tests

- [x] 4.1 An expired CIMD client past its grace returns a slot; one inside its grace does not
- [x] 4.2 A returning retired client id revives its own record and does not increase the count
  - Tested as the sound rule: it revives its own record into one free slot, and a full partition refuses it.
- [x] 4.3 A consumed bootstrap authority retires its client, and that client still cannot be enabled or repurposed
  - Tested on a retired bootstrap client, because no transition consumes an authority any more (2.2).
- [x] 4.4 A client with a live token is refused retirement
  - One case for each kind of live authority. Each client meets every other retirement condition, and retires once that one authority ends.
- [x] 4.5 Reclaim in one partition does not change the other partition's headroom
- [x] 4.6 No test restates a bound: derive expected values from `exomem_oauth_client_partition_available`, as the rewritten capacity test in `oauth-postgres.integration.test.ts` now does
  - The auto-registered and generic bound tests now read the bound from `exomem_oauth_client_partitions()`.
- [x] 4.7 A generic client retires only after its grace, counted from its last grant activity, and its identifier then stops working
- [x] 4.8 The database refuses to enable a retired client and to retire the first-party client
- [x] 4.9 The reconcile job runs the sweep beside its other lanes and reports a sweep failure
- [x] 4.10 A connector that never held a grant retires after the idle client grace; one that held a grant waits for the lapsed connector grace
- [x] 4.11 A bound changed in its table applies to the next registration
- [x] 4.12 The token endpoint answers `invalid_client` for a client that holds no registration, on both grant types
- [x] 4.13 The operator enable action refuses a retired client
- [x] 4.14 A refresh fetches a connector's lapsed metadata again only for a live refresh token, and a failed fetch keeps the refusal. Only failed fetches count against a limit for each client ID, so a herd of refreshes for one shared client ID is never refused while its document is fine

## 5. Production capacity

- [x] 5.0 Write the read-only enumeration and the retirement statement into the runbook
  - "Retire spent reviewer bootstrap clients". The statement skips any client that holds live authority.
- [ ] 5.1 Enumerate the spent operator clients currently on production and show the list before acting
- [ ] 5.2 Retire them as an explicit, operator-approved step — deliberately not part of the migration, because it changes live capacity rather than preventing future exhaustion
- [ ] 5.3 Confirm reported operator headroom afterwards, and decide with evidence whether the `0051` bound of 96 should return to 32
  - The bound is now a row in `exomem_oauth_client_partition_bounds`, so the decision is one UPDATE.
