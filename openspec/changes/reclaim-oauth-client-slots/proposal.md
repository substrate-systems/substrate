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
UPDATE` spares a *returning* client id, but every **distinct** id is permanent. After 128
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
- Retire an expired CIMD client automatically, after a grace period, in the sweep that
  already disables it.
- Retire a spent reviewer bootstrap client automatically once its authority is consumed or
  revoked and its assignment is over. Such a client is already permanently unusable.
- Never retire a client that is enabled, or that has any live grant, access token or
  refresh token.
- Report partition headroom as authoritative server state, so exhaustion is visible before
  it blocks a window rather than at the moment it does.

## Impact

- Affected specs: `exomem-hosted-mcp-oauth`
- Affected code: `exomem_oauth_client_partition_available` and a new migration column;
  `pruneExpiredOAuthState` in `src/lib/exomem-hosted/oauth-store.ts`; the reviewer
  bootstrap consume/revoke paths; the operator contracts admin surface for headroom.
- Affected tooling: `scripts/reviewer_bootstrap.py` in the `exomem` repository reports
  headroom against a hardcoded `OPERATOR_CLIENT_BOUND`; it should read the reported value
  rather than restate one.

## Non-Goals

- Removing the partition. The split between operator and auto-registered provenance is the
  actual security property and is unchanged.
- Raising either bound further. This change is about giving slots back, not about having
  more of them.
- Deleting client rows. Reclaim is retirement, not erasure.
- Any change to which clients may be admitted, or to the CIMD host allowlist.
