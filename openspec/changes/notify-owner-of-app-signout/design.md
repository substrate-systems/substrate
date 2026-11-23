# Design

## A family is live while it holds a usable credential

`exomem_oauth_family_live_until(family_id)` (STABLE) defines when a family
stops being able to reach the cell: the expiry of its last unconsumed
refresh token, or — for a family issued without refresh — the expiry of its
last unrevoked access token. The refresh token's `expires_at` is the real
idle window; the family row's `expires_at` is only the session ceiling the
tokens are already capped by, so a family whose last refresh lapsed is dead
even while the row reads unexpired for months. A spent refresh token never
counts.

`exomem_oauth_family_ended_at(revoked_at, live_until)` then defines the
ending as `LEAST(revoked_at, live_until)` — the earlier of a revocation and
the credential's own death; NULL means the family never held a credential
and has no ending date to tell. Home's per-grant aggregate, the sweep's
detection and the send-time recheck all take "live" and "ended" from these
two functions, so they cannot drift. `live_until` reads the token tables,
so it is STABLE and cannot sit in an index; the sweep's range scans drive
from token indexes instead (below).

## Reachability is per-grant, computed in the one list query

A grant can reach the Exomem iff at least one family under it is unrevoked
with `live_until > now()`. `ownerAppRows` adds a `LEFT JOIN LATERAL`
aggregate over the grant's families returning `live_families` and
`last_ended_at` (the max ended-at = when the last live family ended). The
`(grant_id, revoked_at, id)` covering index keeps it an index-only scan per
family plus one probe per family into the token indexes; the existing
partial live-family index stays for refresh lookups.

State mapping is exact and total: `live_families > 0` → signed in;
`0` → signed out (since `last_ended_at`, or no date when the grant never
held a family); anything else — null, absent, not a number — or a missing
field on the wire → unknown. The Home client never upgrades a failed or
unparseable state to signed in.

## Detection finds the _last_ ending per grant, inside a lookback

The sweep lane selects, per grant, the _latest_-ended family inside the
lookback window (25 h — long enough to cover missed runs, short enough to
keep the anti-join scan bounded). Two drivers land the endings inside the
window on their own range scans: a family's `revoked_at` (partial index on
`revoked_at`) and an unconsumed refresh token's `expires_at` where it is
the family's last (index on `expires_at WHERE consumed_at IS NULL`). Only
refresh-bearing families produce an ending: a family issued without refresh
loses reachability by design when its access token lapses minutes after
sign-in, so treating that lapse — or a later revocation of the dead family —
as a notice would email a still-in-use app every day, and probing every
expired, unpruned access token is the lane's most expensive scan. Home still
reads its state from `live_until`, but the sweep pretends it never ended.
Each driver's "is this the last" check probes its per-family index, so the
lane never scans a token table end to end.

`DISTINCT ON (grant_id) ... ORDER BY ended_at DESC` picks the latest ending
before per-ending predicates apply: the latest ending is the one that took
reachability, so an earlier ending can never backfill a notice — when the
latest is already marked or was a silent ending the grant yields no
candidate. The claim re-verifies the candidate is still the latest ending,
so a newer ending between list and claim wins the attribution instead.
Batched at 100 per run, oldest ended first.

The grant-level facts are probed per candidate by primary key and fix
"connected app" the way Home defines it: the Cloud resource, a client that
is not `first_party` (Home's own channel families — no-refresh by design —
can never email the owner about themselves), a live non-reviewer tenant
(`marketplace_reviewer_purpose` excluded, as the ready email does), a live
owner, and use within the last 14 days
(`exomem_oauth_grant_usage.last_used_at`).

## Owner-action endings are a closed set of existing reasons

`revoked_reason` is written only by this codebase, so the vocabulary lives
in one module (`oauth-family-end.ts`): every writer names its reason through
the exported constants, and one exhaustive `Record<Reason, boolean>` classifies
whether the ending emails — a new reason fails to compile until classified.
Silent: `owner_disconnected`, `client_revoked`, `lifecycle_deleted`,
`cloud_cell_deleted`, `reviewer_credential_revoked`. An expiry (no reason)
and `refresh_replayed`, `operator_revoked` are system endings and notify.
Account deletion cannot notify regardless: the live-tenant join already
excludes deleted tenants and users.

## Idempotence: marker row per emailed family, cap per grant

`exomem_oauth_app_signout_notices` keys on `family_id`: inserting the marker
and enqueueing the email happen in one transaction, and
`ON CONFLICT DO NOTHING` on the primary key makes concurrent sweeps claim a
family once. Markers exist only for endings that emailed (`emailed_at NOT
NULL`): an ending the per-grant 24 h cap suppresses gets no marker, so it is
seen again once the cap lifts and still emails if the app is dead — one email
per distinct sign-out, spaced by the cap, rather than silence forever. Being
seen again requires its evidence to survive the wait: the sweep's prune keeps
a family the cap still suppresses — unmarked, with an emailed marker on its
grant inside the cap — instead of deleting it in the run that suppressed it;
the hold releases when the family is marked or the cap lets go. The
cap itself reads emailed markers on `(grant_id, emailed_at)`. The outbox
`dedupe_key` (`app-signout:<family_id>`) is the second belt for exactly-once
enqueue. `family_id` is deliberately not a foreign key: the sweep deletes an
expired family in the same run that notices it, and the marker must outlive
the family — it is the send-time check's record of the ending and the cap's
record of the email. Markers older than 30 days are pruned in the same sweep,
bounded per run.

The tenant and grant rows are locked in their own statements before the
claim, tenants first (in id order), then grants — the order every path that
writes these rows already takes (code exchange, `disconnectOwnerApp` and
account revocation each lock the tenant `FOR UPDATE` first). Locking in the
sweep's own statements serializes two sweeps racing the same grant, and the
claim's `READ COMMITTED` snapshot postdates the locks — a lock inside the
claim would still read the snapshot taken before the wait, missing a marker
the other sweep just committed. Matching the tenant-first order matters
just as much: the sweep's outbox insert key-share-locks the tenant, so
taking the grant first would complete the cycle the reproduced deadlock ran
(disconnect held the tenant and waited on the grant the sweep held). Both
locks are `FOR NO KEY UPDATE`: the sweep never writes either row, and the
weaker mode does not block the key-share lock code exchange takes on the
grant through its family insert. Endings at the same instant (a mass
revocation stamps one `now()` on them all) share one emailed marker's
`ended_at`, so the second email the twin would send is suppressed
permanently rather than retold a day later.

## The email re-verifies its fact at send time

The outbox `stillHolds` anchors on the marker row — the family itself may
have been deleted between enqueue and send — and re-reads grant, tenant and
usage state: it cancels when the grant was revoked or deleted since enqueue
(owner disconnect, account deletion), when any family is live again by the
same `live_until` rule (owner reconnected), when the tenant turned out a
reviewer's, or when the 14-day recency lapsed. Only then does it send the
short email naming the app by `oauthClientDisplayName` — self-declared names
marked as the app's own claim — the ended date, that saves do not reach the
Exomem until reconnection, and "Open `<app>` and connect Exomem again".

## Operator visibility

Each queued notice emits `oauth.app_signout.notified` with the tenant id and
`emailKind: app_signout` — metadata only, no app names, no content.
