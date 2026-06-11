# hosted-backup-operations Specification

## Purpose
TBD - created by archiving change harden-hosted-backup-operations. Update Purpose after archive.
## Requirements
### Requirement: Scheduled cron execution

The system SHALL schedule its maintenance crons via `vercel.json`:
`/api/cron/claim-followups` daily at 12:00 UTC and `/api/cron/backup-gc`
daily at 03:17 UTC. Every cron route SHALL reject requests that do not carry
`Authorization: Bearer <CRON_SECRET>`, and SHALL fail closed (reject all
requests) when the `CRON_SECRET` environment variable is unset.

#### Scenario: scheduled invocation is accepted
- **GIVEN** `CRON_SECRET` is set
- **WHEN** Vercel invokes `GET /api/cron/backup-gc` with `Authorization: Bearer <CRON_SECRET>`
- **THEN** the run executes and responds 200 with per-pass counts

#### Scenario: unauthenticated invocation is rejected
- **GIVEN** `CRON_SECRET` is set
- **WHEN** `GET /api/cron/backup-gc` is called without the bearer secret
- **THEN** the response is HTTP 401 and no GC work is performed

#### Scenario: missing secret fails closed
- **GIVEN** `CRON_SECRET` is unset
- **WHEN** `GET /api/cron/backup-gc` is called with any Authorization header
- **THEN** the response is HTTP 401 and no GC work is performed

### Requirement: Hard deletes enqueue their R2 prefix atomically

Deleting a backup (`DELETE /api/backups/:id`) and deleting an account SHALL
enqueue the corresponding R2 prefix into `r2_purge_queue` in the same SQL
statement as the hard delete, so a prefix is enqueued if and only if the
delete removed a row.

#### Scenario: backup delete enqueues its prefix
- **GIVEN** user `u-1` owns backup `b-1`
- **WHEN** `u-1` calls `DELETE /api/backups/b-1`
- **THEN** the backup row is removed
- **AND** `r2_purge_queue` gains a pending row for `users/u-1/backups/b-1/`

#### Scenario: failed delete enqueues nothing
- **GIVEN** backup `b-2` is not owned by user `u-1`
- **WHEN** `u-1` calls `DELETE /api/backups/b-2`
- **THEN** the response is 404
- **AND** no `r2_purge_queue` row is created

#### Scenario: account delete enqueues the user prefix
- **GIVEN** user `u-3` requests account deletion
- **WHEN** the deletion cascade removes the `users` row
- **THEN** `r2_purge_queue` gains a pending row for `users/u-3/`

### Requirement: Garbage collection purges soft-deleted versions after the 7-day window

The `backup-gc` cron SHALL find versions soft-deleted more than 7 days ago,
delete their chunk and manifest objects from R2 **before** hard-deleting the
version rows, and SHALL bound the work per run. A failed R2 deletion SHALL
leave the version rows intact so the next run retries.

#### Scenario: expired soft-deleted version is purged
- **GIVEN** a version soft-deleted 8 days ago with 3 chunks and a manifest in R2
- **WHEN** the GC run executes
- **THEN** the 4 R2 objects are deleted
- **AND** the version row (and its chunk rows) are hard-deleted

#### Scenario: R2 failure preserves the retry record
- **GIVEN** R2 object deletion fails for a version
- **WHEN** the GC run executes
- **THEN** the version rows remain in the database
- **AND** the run continues with the remaining versions

#### Scenario: recent soft-deletes are untouched
- **GIVEN** a version soft-deleted 2 days ago
- **WHEN** the GC run executes
- **THEN** its R2 objects and rows are untouched

### Requirement: Garbage collection drains the purge queue

The `backup-gc` cron SHALL list and delete all R2 objects under each pending
`r2_purge_queue` prefix, and SHALL mark a queue row purged only once its
prefix lists empty.

#### Scenario: prefix purged and marked
- **GIVEN** a pending queue row whose prefix contains objects in R2
- **WHEN** the GC run executes
- **THEN** the objects under the prefix are deleted
- **AND** the row's `purged_at` is set once the prefix is empty

#### Scenario: partially drained prefix stays pending
- **GIVEN** a prefix with more objects than one run's page budget
- **WHEN** the GC run executes
- **THEN** the run deletes up to its budget
- **AND** the queue row remains pending for the next run

### Requirement: Garbage collection sweeps abandoned uploads

The `backup-gc` cron SHALL soft-delete versions older than 48 hours whose
manifest object does not exist in R2 (definitive abandonment: presigned PUT
URLs expire after 5 minutes, so the manifest can never appear later).
Versions whose manifest exists SHALL be stamped `manifest_seen_at` and not
re-checked on subsequent runs. Only an explicit not-found from R2 SHALL count
as absence; transport errors SHALL leave the version unchanged.

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

### Requirement: Credential endpoints are rate limited

The system SHALL throttle credential endpoints with sliding-window counters
and respond `RATE_LIMITED` (HTTP 429) at the limit: login failures per
account (10 / 15 min) and per IP (30 / 15 min); recovery-proof failures per
account and per IP (5 / hour); signup attempts per IP (10 / hour).
Successful logins SHALL NOT consume login budget.

#### Scenario: login brute force is throttled per account
- **GIVEN** 10 failed password attempts for `a@example.com` within 15 minutes
- **WHEN** an 11th attempt arrives for `a@example.com`
- **THEN** the response is HTTP 429 `RATE_LIMITED` before credentials are checked

#### Scenario: successful login does not consume budget
- **GIVEN** 9 failed attempts for `a@example.com` within 15 minutes
- **WHEN** a correct-password login succeeds and another correct login follows
- **THEN** both succeed (success recorded no failure events)

#### Scenario: recovery brute force is throttled
- **GIVEN** 5 invalid recovery proofs from one IP within an hour
- **WHEN** a 6th proof arrives from that IP
- **THEN** the response is HTTP 429 `RATE_LIMITED`

#### Scenario: signup spam is throttled per IP
- **GIVEN** 10 signup attempts from one IP within an hour
- **WHEN** an 11th signup arrives from that IP
- **THEN** the response is HTTP 429 `RATE_LIMITED`

### Requirement: Rate-limit events are pruned

The `backup-gc` cron SHALL delete `rate_limit_events` rows older than 24
hours so the table stays bounded.

#### Scenario: old events pruned
- **GIVEN** rate-limit events older than 24 hours
- **WHEN** the GC run executes
- **THEN** those rows are deleted

