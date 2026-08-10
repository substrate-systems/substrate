## ADDED Requirements

### Requirement: Version creation and publication are separate events

Every newly created version SHALL remain unpublished regardless of the
request-side `X-Endstate-API-Version` header. A caller advertising schema
`2.1` or newer publishes through the explicit commit endpoint. Older,
absent, and malformed callers are reconciled by the server only after a
bounded verification has proved the manifest and every expected chunk present
at its declared encrypted length.

#### Scenario: a 2.1 client is told it must commit

- **GIVEN** a client sending `X-Endstate-API-Version: 2.1`
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** the response includes `requiresCommit: true`
- **AND** the version is recorded but not published

#### Scenario: a 2.0 client is reconciled by the server

- **GIVEN** a client sending `X-Endstate-API-Version: 2.0`
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** the response includes `requiresCommit: true`
- **AND** the version remains unpublished until bounded server verification

#### Scenario: a client that sends no version header is reconciled by the server

- **GIVEN** a client that sends no `X-Endstate-API-Version` request header
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** `requiresCommit` is true
- **AND** the version remains unpublished until bounded server verification

#### Scenario: an unparseable version header fails closed

- **GIVEN** a client sending `X-Endstate-API-Version: banana`
- **WHEN** it calls `POST /api/backups/b-1/versions`
- **THEN** `requiresCommit` is true

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

#### Scenario: Release A bridges only pre-cutoff history

- **GIVEN** a version created before the commit protocol existed
- **WHEN** migration 0040 is applied
- **THEN** the row remains intact but is marked `legacy_unverified`
- **AND** it remains temporarily listable, downloadable, retention-eligible,
  and visible-usage eligible while the singleton policy is non-strict
- **AND** every row created after the migration cutoff remains invisible until
  the bounded verifier proves every expected R2 object and length

#### Scenario: strict cutover refuses unfinished history

- **GIVEN** a pre-cutoff `legacy_unverified` row remains pending
- **WHEN** an operator runs the strict-cutover command
- **THEN** the command refuses without changing the singleton policy

#### Scenario: strict cutover is explicit and permanent for rollout

- **GIVEN** no pre-cutoff legacy row remains pending
- **WHEN** an operator explicitly confirms the strict-cutover command
- **THEN** the singleton policy enables strict visibility
- **AND** migration and cron never enable it automatically

### Requirement: Version creation has a stable operation identity

New engines SHALL send their stable per-backup push identity in
`X-Endstate-Operation-ID`. The body `operationId` field remains an additive
compatibility carrier. If both are supplied they SHALL match; malformed,
empty, or conflicting identifiers SHALL be rejected. When discovery advertises
`version-create-operation-replay-v1`, a replay while pending SHALL return the
original version and replacement checksum- and metadata-bound staging URLs; a
replay after commit SHALL return HTTP 200 with the same version ID,
`alreadyCommitted: true`, and no PUT URLs. A changed payload SHALL return 409
without mutation. A failed quota reservation SHALL return quota exceeded rather
than recursively retrying.

#### Scenario: engine header replays one version

- **GIVEN** a version creation carrying `X-Endstate-Operation-ID: push-1`
- **WHEN** the engine retries the same request with that header
- **THEN** it receives the same version id and refreshed upload URLs

#### Scenario: a committed operation has a terminal replay result

- **GIVEN** the operation `push-1` has committed successfully
- **WHEN** the engine retries version creation with `push-1`
- **THEN** the server returns HTTP 200 with `alreadyCommitted: true`
- **AND** it returns the original version ID and an empty upload URL list

#### Scenario: an operation cannot be replayed with a changed payload

- **GIVEN** the operation `push-1` created a pending version
- **WHEN** version creation reuses `push-1` with different manifest or chunk metadata
- **THEN** the server returns HTTP 409
- **AND** it does not mutate the pending version or mint PUT URLs

### Requirement: Operation replay is a rollout-gated discovery capability

OIDC discovery SHALL omit `endstate_extensions.backup_api_capabilities` by
default. Only when the explicit server rollout flag is enabled SHALL it expose
`version-create-operation-replay-v1`. The server SHALL reject replay lookup,
publication, and URL minting with a retryable failure while the target version
has a non-null `gc_reclaim_token`. Before minting replacement URLs, the server
SHALL atomically place a provisional stale-reclaim fence. After every
replacement URL has been signed, it SHALL token-CAS extend that fence through
the latest actual URL expiry plus clock-skew allowance. The operation identity, payload
binding, original version ID, and commit disposition SHALL be stored outside
the generation lifecycle so retention soft- or hard-deletion cannot turn a
terminal replay into a new create or weaken mismatch validation.

#### Scenario: discovery leaves the capability off by default

- **GIVEN** no replay rollout flag is configured
- **WHEN** the OIDC discovery document is fetched
- **THEN** it does not include `backup_api_capabilities`

#### Scenario: a GC lease fences replay

- **GIVEN** GC has set `gc_reclaim_token` on a pending operation version
- **WHEN** the owner retries creation or publication
- **THEN** the server returns a retryable failure
- **AND** it mints no upload URLs or publishes the version

#### Scenario: replay and stale reclaim interleave

- **GIVEN** a stale pending version with an operation identity
- **WHEN** the owner starts an identical replay and the server signs replacement URLs
- **THEN** the version has an active token-bound replay fence through the latest
  actual URL expiry plus clock-skew allowance
- **AND** the stale-reclaim worker cannot claim that version until the fence expires

#### Scenario: retention cannot erase a terminal operation

- **GIVEN** an operation whose version committed successfully
- **WHEN** retention soft-deletes and later hard-deletes that version
- **THEN** an identical replay returns the original version ID with `alreadyCommitted: true`
- **AND** a different payload still returns HTTP 409

### Requirement: Modern upload URLs bind ciphertext checksums

For a `clientCommitRequired` version, every presigned PUT URL SHALL require
both `If-None-Match: *`, the base64 SHA-256 checksum of the expected
ciphertext, and immutable `x-amz-meta-endstate-sha256` metadata. Commit SHALL
compare the metadata hash and length with the stored metadata before
publication. A returned R2 checksum is checked when available, but is not a
required provider capability. A legacy/reconciliation upload SHALL remain
unsigned and size-verified only for old-client compatibility.

#### Scenario: a modern retry sees an existing correct object

- **GIVEN** a modern PUT reached R2 but its 2xx response was lost
- **WHEN** the same conditional, checksum-bound PUT is retried
- **THEN** R2 may return 412 without allowing an overwrite
- **AND** the engine can treat the object as already uploaded

#### Scenario: wrong bytes cannot commit at the expected size

- **GIVEN** an object exists at the expected encrypted length but has a different checksum
- **WHEN** the modern client calls commit
- **THEN** publication fails and the version remains pending

#### Scenario: operation identifiers cannot disagree

- **GIVEN** a request whose header and body operation identifiers differ
- **WHEN** version creation is called
- **THEN** it returns `BAD_REQUEST` and creates no version

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

The system SHALL apply the 5-version retention cap only when a version is
published, not when it is created, and SHALL rank and evict only visible
versions. A push that is never committed or verified SHALL soft-delete nothing.

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

### Requirement: Garbage collection reclaims never-committed versions

The `backup-gc` cron SHALL find versions that were created under the
the pending protocol and left unpublished for longer than a short, named window
measured in hours, delete their chunk and manifest objects from R2 **before**
removing the version rows, and bound the work per run. Because the row was
never visible, reclamation SHALL be a hard delete with no soft-delete window.
Versions that are committed, still within the window, or selected for bounded
legacy reconciliation SHALL NOT be reclaimed.

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

- **GIVEN** an uncommitted version created minutes ago, a committed old version, and a legacy-unverified version
- **WHEN** the GC run executes
- **THEN** none of them are reclaimed

#### Scenario: reclamation never soft-deletes

- **GIVEN** a stale uncommitted version
- **WHEN** the GC run executes
- **THEN** the version is hard-deleted rather than marked `deleted_at`

#### Scenario: reclamation fences legacy publication

- **GIVEN** the stale-reclaim worker has leased an eligible old-client row
- **WHEN** either cron or manual legacy reconciliation selects publication candidates
- **THEN** that row is excluded while its reclaim token is present
- **AND** a publication update compares-and-sets on the token still being absent
- **AND** reclamation and publication cannot both succeed for one generation

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

### Requirement: Grace expiry is persisted before retention begins

The backup GC SHALL atomically advance an expired `grace` row to `cancelled`
when Paddle's final event is missing. Its `cancel_started_at` SHALL equal the
deterministic grace deadline, not the cron run time. Resubscription before this
transition preserves the subscriber's history; the normal Paddle transition
wins and no purge is scheduled.

#### Scenario: missed cancellation webhook starts a durable clock

- **GIVEN** a subscription has been in `grace` for 31 days
- **WHEN** the backup GC runs
- **THEN** its stored status becomes `cancelled`
- **AND** `cancel_started_at` equals `grace_started_at + 30 days`
- **AND** its 30-day cancellation retention is subsequently eligible for purge

## MODIFIED Requirements

### Requirement: Garbage collection sweeps abandoned uploads

The `backup-gc` cron SHALL soft-delete versions older than 48 hours whose
manifest object does not exist in R2 (definitive abandonment: presigned PUT
URLs expire after 5 minutes, so the manifest can never appear later).
Versions whose manifest exists SHALL be stamped `manifest_seen_at` and not
re-checked on subsequent runs. Only an explicit not-found from R2 SHALL count
as absence; transport errors SHALL leave the version unchanged.

This sweep is a backstop for definite manifest absence. It SHALL NOT be
weakened by the pending-version pass. It cannot detect a partial upload whose
manifest is present but whose chunks are missing — clients upload the manifest
first — which is why the pending-version reclaim exists.

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
