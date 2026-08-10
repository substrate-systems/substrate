## Context

Hosted Backup's storage layer has one structural assumption that is false:
that the server can know an upload succeeded. It cannot. Chunks go directly
from the client to R2 over presigned URLs, so the only party that knows the
push completed is the client — and nothing in the API lets it say so.

Everything downstream inherits that. `listVersions`, `listBackupsForUser`,
`sumActiveStorageForUser` and `getUserBackupStats` all filter on
`deleted_at IS NULL` alone, so "row exists" is treated as "backup exists".
`softDeleteVersionsBeyondRetention` runs from `createVersionWithUploads`
before any byte moves, so the retention cap is applied against a version that
may never materialise.

Constraints:

- Existing subscribers are on schema 2.0 engines that have no commit call.
  Any gate must not strand them.
- `db.ts` is the single SQL owner in this module; queries do not leak out.
- The `r2_purge_queue` + `deleteObjects` machinery already exists and is
  crash-safe. New reclamation must reuse it, not duplicate it.

## Goals / Non-Goals

Goals:
- A version is visible only when its bytes are known to be in R2.
- A failed push destroys nothing.
- Abandoned uploads stop consuming quota within hours, not never.
- The grace and post-cancellation windows in code match the published Terms.

Non-Goals:
- Server-side verification of chunk presence at commit. The server would have
  to HEAD every chunk on the request path; the client already knows, and the
  contract is not a trust boundary here (the data is E2E-encrypted anyway —
  a lying client only harms itself).
- Chunk-level deduplication, resumable multi-session pushes, per-plan quotas.
- Deleting accounts on cancellation. §10 says the account survives.

## Decisions

**Decision: two-phase create/commit, negotiated per request.**
`requires_commit` is stored per row rather than inferred globally, because the
population is mixed: a 2.0 engine and a 2.1 engine can push to the same
account on the same day. Storing the negotiated decision on the row means the
visibility predicate is a pure function of the row, with no ambient
version state, and a client is only ever held to the protocol it spoke.

The predicate is `deleted_at IS NULL AND (requires_commit = false OR
committed_at IS NOT NULL)`.

*Alternatives considered.* A global feature flag — rejected: it strands 2.0
clients the moment it flips. Inferring from the presence of a commit call —
rejected: unknowable at create time, which is when the row is written.
Making commit mandatory for everyone — rejected: it is a breaking change and
would require the 90-day dual-major window of §11 for what is otherwise an
additive fix.

**Decision: retention prunes at commit for 2.1, at create for 2.0.**
The literal defect is the pre-upload prune, so the instinct is to delete that
call outright. But a 2.0 client has no commit call, so removing it entirely
leaves that population with no retention enforcement at all — versions
accumulate without bound and quota fills up. That is a real regression traded
for a cosmetic one. The prune therefore stays on the legacy path only, where
it reproduces today's behaviour exactly, and moves to commit on the 2.1 path,
where it is safe. The 2.0 path keeps the old failure mode; the only way to
close it for those clients is for them to upgrade, which is what the
negotiated header is for.

Retention additionally now ranks and evicts only *visible* versions, so an
uncommitted row can neither occupy a retained slot nor be soft-deleted by
retention. Without that, an abandoned push would still displace a good
version from the top-5 window even though the prune had moved.

**Decision: commit is idempotent by pre-image, not by upsert.**
`commitVersion` reads the row's `committed_at` in a materialised CTE and only
UPDATEs where it is NULL, returning the pre-image alongside. A replay
therefore gets the ORIGINAL timestamp and `already_committed = true`, and the
caller skips the prune entirely. Stamping `now()` unconditionally would let
retries slide the commit time forward and re-run a destructive prune on every
delivery of an at-least-once call.

**Decision: uncommitted versions are hard-deleted, not soft-deleted.**
The 7-day soft window exists for accidental-deletion recovery of something the
user could see. An uncommitted version was never visible and its chunks are
incomplete by definition, so there is nothing to recover. R2 objects are
deleted before the row, matching Pass A, so an interrupted run retries rather
than orphaning keys.

**Decision: the reclaim window is hours, not 48 hours.**
Presigned PUT URLs live 5 minutes. A commit that has not arrived within hours
is not arriving, and every hour it is not reclaimed is quota the subscriber
paid for and cannot use. 6 hours is generous enough for a large backup on a
poor connection and far short of the 48-hour manifest sweep, which stays as
the backstop for 2.0 clients that owe no commit.

**Decision: post-cancellation purge deletes data, not accounts.**
`deleteUserCascade` removes the `users` row. §10 promises the opposite —
"The user's account remains. They can re-subscribe at any time." So the purge
deletes `backups` (versions and chunks cascade), enqueues
`users/<id>/backups/` on `r2_purge_queue` in the same statement as the delete
(the cascaded rows carried the only object-key knowledge), and downgrades the
stored status to `none`. Pass B drains the queue exactly as it does for
backup and account deletion — one purge path, not two.

**Decision: read-time cutoffs as well as a scheduled job.**
`getSubscriptionStatus` applies both windows in SQL, so entitlement is correct
the moment a window closes rather than whenever the next cron run happens.
The job then makes the stored state agree and does the irreversible part.

## Risks / Trade-offs

- **A 2.1 client that creates versions and never commits** silently loses
  them. → Mitigated by the response carrying `requiresCommit: true`, by the
  contract stating it, and by the reclaim being logged and counted in the GC
  outcome so a systematically broken client is visible in analytics.
- **Bumping `SchemaVersion` to 2.1 changes a header several tests assert on.**
  → Those assertions were updated; the engine's compatibility check is on the
  MAJOR version (§11), which is unchanged, so no engine is locked out.
- **Grace 14 → 30 keeps lapsed subscribers entitled two weeks longer.** →
  Accepted deliberately: it is what we published, and it is user-favourable.
- **The post-cancellation purge is irreversible.** → Bounded per run,
  driven by a single named constant shared with the read-time cutoff so the
  promise and the deletion cannot drift, and covered by a Postgres test that
  asserts a subscriber 5 days into cancellation is untouched.
- **Legacy (2.0) pushes keep the failed-push-evicts-a-good-version bug.** →
  Unavoidable without breaking them; documented above and in the contract.

## Migration Plan

Migration `0040_backup_version_commit.sql` is additive and online-safe:
`committed_at` is nullable, and both `requires_commit` and
`client_commit_required` default to `false`. That matters during a rolling
deployment: the old application still omits the new columns, so its rows are
selected for bounded server reconciliation rather than mistaken for an
explicit-commit client and reclaimed.

The backfill retains each old row but marks it `legacy_unverified`; the server
must prove its manifest and every expected chunk before visibility. Rollout
must run the bounded verifier before exposing the new read predicate broadly.

Rollback: revert the application code only after pausing the new commit-aware
writer. The additive columns can remain; their `false` defaults keep old-app
rows on the reconciliation path and avoid classifying them as explicit commit.
Do not drop the columns or mark legacy rows verified as a rollback shortcut.

## Open Questions

- Should `POST .../download-urls` also refuse uncommitted versions? Today it
  does not, because a client can only learn a version id from a visible
  listing or from its own create call. Adding the predicate there would be
  defence in depth at the cost of breaking a client that legitimately wants to
  re-PUT. Deferred.
- Should the engine be able to discover `requiresCommit` support from the OIDC
  discovery document rather than inferring it from the response header?
  Deferred to the engine-side change.
