## 1. Retirement state

- [ ] 1.1 Migration: add `retired_at timestamptz` to `exomem_oauth_clients`, defaulting to NULL
- [ ] 1.2 Count only `retired_at IS NULL` rows in `exomem_oauth_client_partition_available`, keeping the provenance partition and both bounds as they are
- [ ] 1.3 Index review: the partition predicate runs on every admission, so measure it before and after rather than assuming the added condition is free

## 2. Automatic retirement

- [ ] 2.1 Retire an expired CIMD client in `pruneExpiredOAuthState`, after a grace period well beyond `CIMD_MAX_TTL_SECONDS`
- [ ] 2.2 Retire a reviewer bootstrap client on the same transition that consumes or revokes its authority
- [ ] 2.3 Refuse retirement for any client that is enabled or holds a live grant, access token, or refresh token — a query, not an age heuristic
- [ ] 2.4 Confirm the existing `ON CONFLICT (client_id) DO UPDATE` path revives a retired row rather than consuming a second slot

## 3. Visibility

- [ ] 3.1 Report per-partition headroom as content-free operator state
- [ ] 3.2 Make `scripts/reviewer_bootstrap.py` in the `exomem` repository read that headroom instead of comparing against its hardcoded `OPERATOR_CLIENT_BOUND`, which `0051` already made stale

## 4. Tests

- [ ] 4.1 An expired CIMD client past its grace returns a slot; one inside its grace does not
- [ ] 4.2 A returning retired client id revives its own record and does not increase the count
- [ ] 4.3 A consumed bootstrap authority retires its client, and that client still cannot be enabled or repurposed
- [ ] 4.4 A client with a live token is refused retirement
- [ ] 4.5 Reclaim in one partition does not change the other partition's headroom
- [ ] 4.6 No test restates a bound: derive expected values from `exomem_oauth_client_partition_available`, as the rewritten capacity test in `oauth-postgres.integration.test.ts` now does

## 5. Production capacity

- [ ] 5.1 Enumerate the spent operator clients currently on production and show the list before acting
- [ ] 5.2 Retire them as an explicit, operator-approved step — deliberately not part of the migration, because it changes live capacity rather than preventing future exhaustion
- [ ] 5.3 Confirm reported operator headroom afterwards, and decide with evidence whether the `0051` bound of 96 should return to 32
