# Design — harden-hosted-backup-operations

## Context

Three operational holes block the public hosted-backup release: unscheduled
crons, stub R2 garbage collection (with two user-facing promises already
written against it), and unthrottled credential endpoints. The fixes must fit
substrate's existing primitives: Neon serverless Postgres via single-statement
`sql` template calls (no client-side transactions), the S3-compatible R2
client in `r2.ts`, the `HostedBackupError` envelope, and `node:test` module
mocks.

## Decision 1 — Purge queue, not synchronous R2 deletion

Backup and account deletion are hard DB deletes; their R2 object keys vanish
with the rows (FK cascade). Deleting R2 objects inline in the request handler
would couple a user-facing DELETE to an unbounded number of R2 round-trips
(up to ~5 versions × N chunks per backup, or a whole account prefix) and
would leave orphans whenever the handler dies mid-way — with no record left
to retry from.

Instead, the delete statement itself enqueues the R2 prefix into
`r2_purge_queue`. The daily `backup-gc` cron drains the queue. This matches
the account UI's "purged within 24 hours" promise and is crash-safe: the
queue row survives until the prefix is confirmed empty.

**Atomicity without transactions.** The Neon HTTP driver executes one
statement per call, so enqueue + delete are combined into a single CTE
statement (`WITH deleted AS (DELETE … RETURNING id) INSERT INTO
r2_purge_queue … WHERE EXISTS (SELECT 1 FROM deleted)`), the same pattern
`insertVersionWithChunks` already uses for multi-table atomicity. A prefix is
enqueued if-and-only-if the delete removed a row — a failed delete cannot
enqueue a purge for live data, and a successful delete cannot lose its
prefix.

## Decision 2 — GC ordering: R2 first, DB second

Pass A deletes R2 objects *before* hard-deleting the version rows that carry
the object keys. If the run crashes between the two, the rows survive and the
next run retries the (idempotent) R2 deletes. The opposite order would orphan
objects with no key record. Same principle in Pass B: `purged_at` is set only
after the prefix lists empty.

## Decision 3 — Abandoned-upload detection via `manifest_seen_at`

A version row is inserted at mint time; there is no "finalized" flag, so an
abandoned upload (client died before PUTting the manifest) is indistinguishable
in the DB from a healthy version. The discriminator is R2 itself: presigned
PUT URLs live 5 minutes, so a manifest absent 48 hours after mint can never
appear later — HEAD-404 at that age is a definitive abandon signal, with no
false-positive window. (This also means the *newest* version of a backup is
safe to sweep when its manifest is absent: it is unusable and, being newest,
is exactly the version the restore default would pick.)

Naive daily HEAD checks of every old version would re-check healthy versions
forever. The new nullable `backup_versions.manifest_seen_at` column caps the
cost: GC only HEADs versions where it is NULL, stamps it on 200, soft-deletes
on 404. Each version is checked at most once (plus cap-deferred retries).

Versions whose manifest uploaded but some chunks did not are not detectable
this way (HEADing every chunk daily is not worth it); they fail restore
explicitly, count against the owner's own quota, and rotate out via the
5-version retention. Accepted residual.

## Decision 4 — DB-backed rate limiting

One table, `rate_limit_events (scope, key, at)`, one helper:
`enforceRateLimit` counts events for `(scope, key)` within the window and
throws `errors.rateLimited()` (existing `RATE_LIMITED`/429 envelope) at the
limit; `recordRateLimitEvent` inserts. No new infrastructure, mockable in
`node:test` exactly like every other db call.

- Failures-only recording for `login` and `recover` (a successful sign-in
  must not consume budget); all-attempts recording for `signup` (spam is the
  threat, successes included).
- Keys: lowercased email for per-account scopes; first `x-forwarded-for` hop
  (Vercel-set) for per-IP scopes, `'unknown'` fallback.
- The check-then-insert pair is not atomic; a burst can slightly overshoot
  the cap. Acceptable for abuse throttling (limits are an order-of-magnitude
  guard, not an exact quota).
- Window state is pruned by GC Pass D (24h), keeping the table tiny.

## Decision 5 — Shared cron auth

`verifyCronAuth` moves to `src/lib/hosted-backup/cron-auth.ts` (fail-closed
when `CRON_SECRET` is unset), used by both cron routes — the stub previously
had **no** auth. `claim-followups` keeps its behavior, just imports the
shared helper.

## Bounds per GC run (daily cadence; backlog drains across days)

| Pass | Cap |
|------|-----|
| A — expired soft-deleted versions | 25 versions |
| B — purge-queue prefixes | 5 prefixes, ≤10 list pages (≤1000 keys each) per prefix |
| C — abandoned-upload HEAD checks | 50 versions |
| D — rate-limit prune | unbounded (single DELETE) |

R2 `DeleteObjects` batches ≤1000 keys (S3 API limit). Every pass reports a
count in the response body for observability; a failed item is logged and
skipped, never blocking the rest of the run.
