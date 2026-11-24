## Why

`exomem_oauth_clients` is bounded by provenance, and neither partition has any way to
give a slot back. The bound is therefore not a control. It is a counter that only ever
goes up, and when it reaches its limit the capability stops permanently.

This has already fired once. Every reviewer bootstrap attempt registers one pinned
operator client, and a client carrying bootstrap history can never be re-enabled or
repurposed by design — so every attempt, successful or abandoned, leaves a permanent
tombstone. Two weeks of promotion windows filled the operator partition to 32 of 32, and
the first promotion of the alpha could not start at all. Preflight named it exactly:

```
WARN  oauth clients: 32 stored, <=0 of 32 operator slot(s) free
      Nothing reclaims a slot through the API.
```

There is no reclaim path in the codebase. The only `DELETE FROM exomem_oauth_clients`
anywhere in the tree is in tests. `0051` raised the operator bound to 96 so the alpha
could proceed; that bought room and fixed nothing.

The CIMD side is the more serious half, because it meters legitimate growth rather than
operator attempts. `pruneExpiredOAuthState` handles an expired client by disabling it:

```sql
UPDATE exomem_oauth_clients
SET enabled = false, metadata_expires_at = now()
WHERE admission_mode = 'cimd' AND metadata_expires_at <= now()
```

while the gate counts rows regardless of `enabled`:

```sql
SELECT count(*) FROM exomem_oauth_clients WHERE auto_registered = p_auto_registered
```

So an expired, disabled CIMD client holds its slot forever. `ON CONFLICT (client_id) DO
UPDATE` spares a _returning_ client id, but every **distinct** id is permanent. After 128
distinct client ids from admitted hosts have ever connected, CIMD admission shuts for
good and no new user can connect, with no code path to reopen it.

This is not an anonymous denial of service — registration requires the metadata document's
host to be in `EXOMEM_CIMD_ALLOWED_HOSTS`, so a stranger cannot flood the partition. It is
worse in one respect: it is triggered by ordinary success, it is silent until it fires,
and its failure mode is permanent.

## What Changes

- Give `exomem_oauth_clients` a retirement state, and count only unretired rows toward
  each partition bound. Reclaiming a slot MUST NOT delete the row: the history of which
  clients existed, and which carried bootstrap provenance, is audit evidence and is also
  what makes "a bootstrap client can never be repurposed" checkable.
- Retire an expired auto-registered CIMD client automatically, after a grace period, in
  the sweep that already disables it. A connector that never held a grant retires after
  the short grace of an idle generic client, so a flood of connector registrations clears
  in a day.
- Keep each partition's bound in a table, so an operator changes it with one UPDATE, and
  size the launch bounds so that normal growth never reaches them. Every ChatGPT connector
  registers its own client, so the auto-registered bound of 128 capped connected ChatGPT
  users at about 128.
- Retire a generic MCP client automatically once it has held nothing usable for a grace
  period. Migration 0062 added the generic partition with the same defect: 128
  registrations fill it once, and it stays full. Its runbook forbids enabling the generic
  lane until reclaim covers it.
- Never retire a client that holds a grant that is not revoked, an unexpired code, access
  token or refresh token, or an authorization in progress.
- Run the sweep from the scheduled reconcile job. `pruneExpiredOAuthState` has no
  production caller today, so expired codes, tokens and families also pile up.
- Report partition headroom as authoritative server state, so exhaustion is visible before
  it blocks a window rather than at the moment it does.
- Answer `invalid_client` at the token endpoint for an unknown or retired client, so an
  MCP client whose registration retired registers again by itself.
- Give the operator a runbook statement that retires the spent reviewer bootstrap clients
  already on production. Nothing creates, consumes or revokes a bootstrap authority since
  Hosted was retired, so no automatic transition remains for them.

## Impact

- Affected specs: `exomem-hosted-mcp-oauth`
- Affected code: migration 0067 (`retired_at`, `exomem_oauth_client_partition_bounds`,
  `exomem_oauth_client_partitions`, the two partition gates,
  `exomem_oauth_clients_holding_live_authority`); `pruneExpiredOAuthState` and the CIMD
  self-registration upsert in `src/lib/exomem-hosted/oauth-store.ts`; the token route; the
  reconcile cron route; the operator OAuth clients admin route for headroom; the operator
  enable action.
- Affected operations: two optional grace settings, and the generic lane's enable
  condition in `docs/runbooks/exomem-cloud-operations.md`.
- Affected tooling: `scripts/reviewer_bootstrap.py` in the `exomem` repository reports
  headroom against a hardcoded `OPERATOR_CLIENT_BOUND`; it should read the reported value
  rather than restate one.

## Non-Goals

- Removing the partition. The split between operator and auto-registered provenance is the
  actual security property and is unchanged.
- Deleting client rows. Reclaim is retirement, not erasure.
- Any change to which clients may be admitted, or to the CIMD host allowlist.
