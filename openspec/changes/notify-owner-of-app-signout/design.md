# Design

## A family "ends" at the earlier of revocation and expiry

One SQL IMMUTABLE function, `exomem_oauth_family_ended_at(revoked_at,
expires_at)`, defines a family's ended time as
`LEAST(expires_at, COALESCE(revoked_at, expires_at))`. Home's per-grant
aggregate, the sweep's detection range scan, and the covering index's
expression all use it, so the three cannot drift apart.

## Reachability is per-grant, computed in the one list query

A grant can reach the Exomem iff at least one family under it is unrevoked and
unexpired. `ownerAppRows` adds a `LEFT JOIN LATERAL` aggregate over the
grant's families returning `live_families` and `last_ended_at` (the max
ended-at = when the last live family ended). A covering index
`(grant_id, expires_at, revoked_at)` keeps it an index-only scan; the existing
partial live-family index stays for refresh lookups.

State mapping is exact and total: `live_families > 0` → signed in;
`0` → signed out (since `last_ended_at`, or no date when the grant never held
a family); anything else, or a missing field on the wire → unknown. The Home
client never upgrades a failed or unparseable state to signed in.

## Detection finds the *last* ending per grant, inside a lookback

The sweep lane selects, per grant, the *latest*-ended family inside the
lookback window (25 h — long enough to cover missed runs, short enough to
keep the anti-join scan bounded) for unrevoked grants whose owner and tenant
are live, whose use was within the last 14 days
(`exomem_oauth_grant_usage.last_used_at`), and which no live family survives.
`DISTINCT ON (grant_id) ... ORDER BY ended_at DESC` picks that ending before
per-ending predicates apply: the latest ending is the one that took
reachability, so an earlier ending can never backfill a notice — when the
latest is already marked or was a silent ending the grant yields no
candidate. The claim re-verifies the candidate is still the latest ending,
so a newer ending between list and claim wins the attribution instead.
Batched at 100 per run, oldest ended first; the expression index on
ended-at serves the range scan.

## Owner-action endings are a closed set of existing reasons

`revoked_reason` is written only by this codebase, so the silent set is one
constant: `owner_disconnected`, `client_revoked`, `lifecycle_deleted`,
`cloud_cell_deleted`, `reviewer_credential_revoked`. An expiry (no reason)
and every other existing reason (`refresh_replayed`, `operator_revoked`)
are system endings and notify. Account deletion cannot notify regardless:
the live-tenant join already excludes deleted tenants and users.

## Idempotence: marker row per emailed family, cap per grant

`exomem_oauth_app_signout_notices` keys on `family_id`: inserting the marker
and enqueueing the email happen in one transaction, and
`ON CONFLICT DO NOTHING` on the primary key makes concurrent sweeps claim a
family once. Markers exist only for endings that emailed (`emailed_at NOT
NULL`): an ending the per-grant 24 h cap suppresses gets no marker, so it is
seen again once the cap lifts and still emails if the app is dead — one email
per distinct sign-out, spaced by the cap, rather than silence forever. The
cap itself reads emailed markers on `(grant_id, emailed_at)`. The outbox
`dedupe_key` (`app-signout:<family_id>`) is the second belt for exactly-once
enqueue. `family_id` is deliberately not a foreign key: the sweep deletes an
expired family in the same run that notices it, and the marker must outlive
the family — it is the send-time check's record of the ending and the cap's
record of the email.

The grant rows are locked `FOR UPDATE` in their own statement before the
claim, serializing two sweeps that race the same grant. It is its own
statement because the claim runs under `READ COMMITTED`: a lock inside the
claim would still read the snapshot taken before the wait, missing a marker
the other sweep just committed; a separate statement makes the claim's
snapshot postdate the lock. Endings at the same instant (a mass revocation
stamps one `now()` on them all) share one emailed marker's `ended_at`, so the
second email the twin would send is suppressed permanently rather than
retold a day later.

## The email re-verifies its fact at send time

The outbox `stillHolds` anchors on the marker row — the family itself may
have been deleted between enqueue and send — and re-reads grant, tenant and
usage state: it cancels when the grant was revoked or deleted since enqueue
(owner disconnect, account deletion), when any family is live again (owner
reconnected), or when the 14-day recency lapsed. Only then does it send the
short email naming the app by `oauthClientDisplayName` — self-declared names
marked as the app's own claim — the ended date, that saves do not reach the
Exomem until reconnection, and "Open `<app>` and connect Exomem again".

## Operator visibility

Each queued notice emits `oauth.app_signout.notified` with the tenant id and
`emailKind: app_signout` — metadata only, no app names, no content.
