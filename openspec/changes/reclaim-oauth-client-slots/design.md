## Context

`exomem_oauth_client_partition_available` bounds the client population separately for
operator-registered and auto-registered clients. The partitioning is sound and is not in
question: it exists so anonymous CIMD registration cannot exhaust the slots an operator
needs, and it does that.

What is missing is the other half of any capacity control — a way for a slot to become
free again. Without it a bound is a countdown, and both partitions are counting down: the
operator one through promotion windows, the CIMD one through ordinary user growth.

## Goals / Non-Goals

**Goals**

- A slot occupied by a client that can never be used again becomes available.
- Reclaim preserves the record. Which clients existed, and which carried bootstrap
  provenance, stays checkable.
- Exhaustion is visible before it blocks something.

**Non-Goals**

- Changing which clients may be admitted, or the CIMD host allowlist.
- Removing the provenance partition, or raising either bound.
- Erasing rows.

## Decisions

### Retire, do not delete

Add `retired_at timestamptz` to `exomem_oauth_clients` and count only
`retired_at IS NULL` rows toward each partition bound.

Deletion is the obvious move and the wrong one. Three reasons, in order of weight:

1. **The invariant depends on the row.** "A client carrying bootstrap history can never be
   re-enabled or repurposed" is enforceable only while the history exists. Delete the row
   and the same `client_id` can be registered fresh, with no trace that it was ever a
   bootstrap client. Reclaim would quietly become a laundering path for exactly the
   identity the one-shot bootstrap exists to burn.
2. **Referential safety.** Grants, tokens and artifacts reference clients. A delete either
   cascades into evidence or fails on a constraint, and which one it does is discovered in
   production.
3. **Audit.** The tombstones are the record of two weeks of promotion attempts.

Retirement is also reversible in the only sense that matters: an id that comes back can be
un-retired by the existing `ON CONFLICT (client_id) DO UPDATE` path, which spares the slot
rather than consuming a second one.

### Retire an expired CIMD client in the sweep that already disables it

`pruneExpiredOAuthState` already visits exactly the right rows. It sets `enabled = false`
on a CIMD client whose metadata has expired; it should also set `retired_at` once the row
has been expired for a grace period.

The grace period is not decoration. A connector that reconnects after a short outage
should find its own row and reuse it; retiring immediately is harmless to correctness but
churns the row on every lapse. A grace period measured in days, well beyond
`CIMD_MAX_TTL_SECONDS`, keeps the common case a no-op.

### Retire a spent bootstrap client when its authority ends

A reviewer bootstrap client is disabled and versioned the moment its authority is consumed
or revoked. From that instant it is permanently unusable — that is the whole design of the
one-shot bootstrap. There is no reason for it to hold a slot, and no operator decision to
make about it, so retirement belongs on the same transition rather than in a separate
sweep or an operator control.

### Never retire a client that could still be in use

Retirement is refused for any client that is `enabled`, or that has any live grant, access
token or refresh token. This is what keeps the mechanism from becoming the reaper the
promotion runbook warns against: it cannot take a slot from something that is working, and
it never has to guess, because liveness is a query rather than a heuristic about age.

### Report headroom

Partition headroom becomes readable server state on the operator surface, so preflight can
report the real number instead of comparing against a bound it restates. The
`OPERATOR_CLIENT_BOUND = 32` constant in `scripts/reviewer_bootstrap.py` is a duplicate of
a database value and was already stale the moment `0051` landed.

## Risks / Trade-offs

**A retired row is invisible to the bound but still occupies storage.** Accepted. Storage
is not the constraint; admission is. If row count ever becomes a real problem, archival is
a separate decision that can be taken with the evidence still intact.

**Automatic retirement acts without an operator in the loop.** Bounded by the liveness
refusal above: the only rows it can touch are ones that are already disabled and already
unusable. The alternative — an operator control — was rejected because a bound that needs
a human to maintain it is the state we are already in, and it is what blocked the alpha.

**A `retired_at` column changes a hot predicate.** The partition function runs on every
admission. The added condition is on the same rows it already counts, and wants the same
index; measure before and after rather than assuming either way.

## Migration Plan

Additive column, defaulting to `NULL`, so every existing row stays counted and behaviour is
unchanged at deploy. Retirement then happens forward: the CIMD sweep retires expired rows
as their grace elapses, and bootstrap clients retire as authorities end.

Whether to backfill `retired_at` for the clients that are already spent — the 29 disabled
pinned tombstones on production today — is deliberately a separate, operator-approved step
rather than part of the migration. It is the one action here that changes live capacity
rather than preventing future exhaustion, and it should be taken deliberately, with the
list enumerated first.

## Open Questions

- The CIMD grace period. Days rather than hours, but the exact value should come from what
  a real connector's reconnection behaviour looks like, which the access log can answer.
- Whether headroom belongs on the existing contracts admin response or its own endpoint.
