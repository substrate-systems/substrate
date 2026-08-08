## ADDED Requirements

### Requirement: Version creation and publication are separate events

The system SHALL negotiate a two-phase version push from the caller's
request-side `X-Endstate-API-Version` header. A caller advertising schema
`2.1` or newer SHALL receive `requiresCommit: true` from
`POST /api/backups/:backupId/versions` and its version SHALL remain
unpublished until committed. A caller advertising an older schema, or sending
an absent or unparseable header, SHALL receive `requiresCommit: false` and
the single-phase behaviour in which the version is live at creation. The
server SHALL fail closed to `false`.

#### Scenario: a 2.1 client is told it must commit
- **GIVEN** a client sending `X-Endstate-API-Version: 2.1`
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** the response includes `requiresCommit: true`
- **AND** the version is recorded but not published

#### Scenario: a 2.0 client keeps the single-phase behaviour
- **GIVEN** a client sending `X-Endstate-API-Version: 2.0`
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** the response includes `requiresCommit: false`
- **AND** the version is immediately listable and restorable with no commit call

#### Scenario: a client that sends no version header is not gated
- **GIVEN** a client that sends no `X-Endstate-API-Version` request header
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** `requiresCommit` is false
- **AND** the version is immediately live

#### Scenario: an unparseable version header fails closed
- **GIVEN** a client sending `X-Endstate-API-Version: banana`
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** `requiresCommit` is false

### Requirement: Uncommitted versions are invisible everywhere

A version awaiting commit SHALL NOT appear in version listings, SHALL NOT
contribute to a backup's `latestVersionId`, `versionCount` or `totalSize`,
SHALL NOT count toward the storage quota, and SHALL NOT be selectable as a
restore target. The same visibility rule SHALL be applied by every read
surface, so a version can never be visible on one and hidden on another.

#### Scenario: an uncommitted version is not listed
- **GIVEN** user `u-1` created a version on backup `b-1` and has not committed it
- **WHEN** `u-1` calls `GET /api/backups/b-1/versions`
- **THEN** the response does not include that version

#### Scenario: an uncommitted version does not consume quota
- **GIVEN** a 1000-byte version on `b-1` that has not been committed
- **WHEN** the user's active storage is summed
- **THEN** those 1000 bytes are excluded

#### Scenario: an uncommitted version does not appear in the backup summary
- **GIVEN** backup `b-1` whose only version is uncommitted
- **WHEN** `u-1` calls `GET /api/backups`
- **THEN** `b-1` reports `latestVersionId: null`, `versionCount: 0` and `totalSize: 0`

#### Scenario: committing publishes the version everywhere at once
- **GIVEN** an uncommitted 1000-byte version on `b-1`
- **WHEN** the version is committed
- **THEN** it is listed, it is the backup's `latestVersionId`, and its bytes count toward quota

#### Scenario: a pre-existing version stays visible after migration
- **GIVEN** a version created before the commit protocol existed
- **WHEN** migration 0038 is applied
- **THEN** the row is backfilled with `committed_at = created_at` and `requires_commit = false`
- **AND** it remains listed and continues to count toward quota

### Requirement: Version commit is idempotent and ownership-scoped

`POST /api/backups/:backupId/versions/:versionId/commit` SHALL require write
access, SHALL publish the version, and SHALL be safe to repeat. A repeat call
SHALL return HTTP 200 with the original commit timestamp and
`alreadyCommitted: true`, and SHALL perform no further retention pruning. A
version belonging to another user, or an unknown version id, SHALL return
HTTP 404 — indistinguishable from one another, per contract §7.

#### Scenario: first commit publishes the version
- **GIVEN** an uncommitted version `v-1` on backup `b-1` owned by `u-1`
- **WHEN** `u-1` calls `POST /api/backups/b-1/versions/v-1/commit`
- **THEN** the response is HTTP 200 with `alreadyCommitted: false` and a `committedAt` timestamp

#### Scenario: replaying the commit is a no-op success
- **GIVEN** `v-1` was already committed
- **WHEN** the same commit call arrives again
- **THEN** the response is HTTP 200 with `alreadyCommitted: true`
- **AND** `committedAt` equals the original timestamp
- **AND** no additional versions are pruned

#### Scenario: another user's version cannot be committed
- **GIVEN** version `v-1` on a backup owned by `u-1`
- **WHEN** user `u-2` calls `POST /api/backups/b-1/versions/v-1/commit`
- **THEN** the response is HTTP 404 `NOT_FOUND`
- **AND** `v-1` remains uncommitted

#### Scenario: commit requires an active subscription
- **GIVEN** a user whose subscription is not `active`
- **WHEN** they call the commit endpoint
- **THEN** the request is rejected before any storage work occurs

### Requirement: Retention is enforced at commit, never before upload

For clients on the two-phase protocol the system SHALL apply the 5-version
retention cap when a version is committed, not when it is created, and SHALL
rank and evict only visible versions. A push that is never committed SHALL
soft-delete nothing. Clients on the single-phase protocol, which have no
commit call, SHALL continue to have retention enforced at creation.

#### Scenario: a failed push does not evict a good older version
- **GIVEN** backup `b-1` holds five committed versions
- **WHEN** a sixth version is created and never committed
- **THEN** all five committed versions remain visible
- **AND** no version was soft-deleted

#### Scenario: committing prunes beyond the retention cap
- **GIVEN** backup `b-1` holds five committed versions
- **WHEN** a sixth version is created and then committed
- **THEN** the oldest committed version is soft-deleted
- **AND** five versions remain visible

#### Scenario: an uncommitted version occupies no retention slot
- **GIVEN** backup `b-1` holds five committed versions and one uncommitted version
- **WHEN** retention is enforced
- **THEN** the uncommitted version is neither counted toward the cap nor soft-deleted

#### Scenario: single-phase clients keep create-time retention
- **GIVEN** a client on schema 2.0 with five existing versions on `b-1`
- **WHEN** it creates a sixth version
- **THEN** retention is enforced at that moment, as before

### Requirement: Garbage collection reclaims never-committed versions

The `backup-gc` cron SHALL find versions that were created under the
two-phase protocol and left uncommitted for longer than a short, named window
measured in hours, delete their chunk and manifest objects from R2 **before**
removing the version rows, and bound the work per run. Because the row was
never visible, reclamation SHALL be a hard delete with no soft-delete window.
Versions that are committed, still within the window, or created by
single-phase clients SHALL NOT be reclaimed.

#### Scenario: a stale uncommitted version and its objects are reclaimed
- **GIVEN** an uncommitted version created well beyond the reclaim window
- **WHEN** the GC run executes
- **THEN** its chunk and manifest objects are deleted from R2
- **AND** the version row is hard-deleted afterwards

#### Scenario: a failed R2 delete leaves the row for the next run
- **GIVEN** a stale uncommitted version whose R2 delete fails
- **WHEN** the GC run executes
- **THEN** the version row is not deleted
- **AND** the run reports an error

#### Scenario: fresh and committed versions are left alone
- **GIVEN** an uncommitted version created minutes ago, a committed old version, and an old single-phase version
- **WHEN** the GC run executes
- **THEN** none of them are reclaimed

#### Scenario: reclamation never soft-deletes
- **GIVEN** a stale uncommitted version
- **WHEN** the GC run executes
- **THEN** the version is hard-deleted rather than marked `deleted_at`

### Requirement: Post-cancellation data is purged after the retention window

The system SHALL treat `cancel_started_at` as authoritative for the 30-day
post-cancellation retention window promised by the contract and the published
Terms. A subscription in `cancelled` past that window SHALL be observed as
`none` at read time, and the `backup-gc` cron SHALL delete that user's backup
rows, enqueue their R2 prefix on the existing purge queue in the same
statement as the delete, and set the stored status to `none`. The user's
account row SHALL survive — post-cancellation purge removes data, not
accounts.

#### Scenario: inside the window the subscriber keeps read access
- **GIVEN** a subscription cancelled 10 days ago
- **WHEN** entitlement is read
- **THEN** the effective status is `cancelled` and reads are permitted

#### Scenario: past the window access is gone
- **GIVEN** a subscription cancelled 31 days ago
- **WHEN** entitlement is read
- **THEN** the effective status is `none`

#### Scenario: expired cancellation purges data and enqueues the prefix
- **GIVEN** a subscription cancelled 45 days ago with one backup
- **WHEN** the GC run executes
- **THEN** the backup and its versions are deleted
- **AND** `r2_purge_queue` gains a pending row for `users/<userId>/backups/`
- **AND** the stored subscription status becomes `none`

#### Scenario: the account survives the purge
- **GIVEN** an expired cancellation that has just been purged
- **WHEN** the users table is inspected
- **THEN** the user row still exists so the person can re-subscribe

#### Scenario: a recent cancellation is untouched
- **GIVEN** a subscription cancelled 5 days ago
- **WHEN** the GC run executes
- **THEN** its backups are not deleted and its status stays `cancelled`

#### Scenario: the purge pass is idempotent
- **GIVEN** an expired cancellation already purged by a previous run
- **WHEN** the GC run executes again
- **THEN** no further rows are downgraded and no further prefixes are enqueued

### Requirement: Subscription grace lasts 30 days

The past-due grace window SHALL be 30 days, matching contract §10 and the
published Terms. A subscription in `grace` whose `grace_started_at` is within
the window SHALL remain entitled to read; past the window it SHALL be
observed as `cancelled`. The cutoff SHALL be applied at read time so
entitlement does not depend on whether a scheduled run has occurred.

#### Scenario: day 20 of grace is still grace
- **GIVEN** a subscription that entered `grace` 20 days ago
- **WHEN** entitlement is read
- **THEN** the effective status is `grace` and reads are permitted

#### Scenario: past 30 days grace ends
- **GIVEN** a subscription that entered `grace` 31 days ago
- **WHEN** entitlement is read
- **THEN** the effective status is `cancelled`
- **AND** the stored status remains `grace` so a late reactivation can still recover the user

## MODIFIED Requirements

### Requirement: Garbage collection sweeps abandoned uploads

The `backup-gc` cron SHALL soft-delete versions older than 48 hours whose
manifest object does not exist in R2 (definitive abandonment: presigned PUT
URLs expire after 5 minutes, so the manifest can never appear later).
Versions whose manifest exists SHALL be stamped `manifest_seen_at` and not
re-checked on subsequent runs. Only an explicit not-found from R2 SHALL count
as absence; transport errors SHALL leave the version unchanged.

This sweep remains the backstop for single-phase clients, which make no
commit and therefore cannot be reclaimed by the uncommitted-version pass. It
SHALL NOT be weakened by that pass. It cannot detect a partial upload whose
manifest is present but whose chunks are missing — clients upload the
manifest first — which is why the uncommitted-version reclaim exists.

#### Scenario: abandoned version is soft-deleted
- **GIVEN** a version minted 3 days ago whose manifest HEAD returns 404
- **WHEN** the GC run executes
- **THEN** the version is soft-deleted (and purged by a later run after the 7-day window)

#### Scenario: healthy version is stamped and skipped thereafter
- **GIVEN** a version minted 3 days ago whose manifest HEAD returns 200
- **WHEN** the GC run executes
- **THEN** `manifest_seen_at` is set
- **AND** subsequent runs do not HEAD it again

#### Scenario: transport error changes nothing
- **GIVEN** the manifest HEAD fails with a non-404 error
- **WHEN** the GC run executes
- **THEN** the version is neither soft-deleted nor stamped

#### Scenario: manifest-present partial upload is left to the commit protocol
- **GIVEN** a two-phase version whose manifest was uploaded but whose chunks were not
- **WHEN** the GC run executes
- **THEN** this sweep stamps it healthy
- **AND** the uncommitted-version reclaim is what removes it
