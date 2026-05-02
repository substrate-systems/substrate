## ADDED Requirements

### Requirement: Backup creation and listing

The system SHALL expose `GET /api/backups` (list) and `POST /api/backups` (create), both auth-gated. `POST` requires the user's subscription status to be `active`.

#### Scenario: Authenticated active user lists their backups
- **WHEN** an authenticated user with `subscriptionStatus = "active"` makes `GET /api/backups`
- **THEN** the response is HTTP 200 with body `{ backups: [...] }`

#### Scenario: Active user creates a backup
- **WHEN** an authenticated user with `subscriptionStatus = "active"` makes `POST /api/backups` with body `{ name: "Workstation" }`
- **THEN** the response is HTTP 200 with body `{ backupId: "<uuid>" }` AND a row exists in `backups` with that id

#### Scenario: User without active subscription cannot create a backup
- **WHEN** an authenticated user with `subscriptionStatus = "none"` or `"grace"` or `"cancelled"` makes `POST /api/backups`
- **THEN** the response is HTTP 402 and `error.code` is `SUBSCRIPTION_REQUIRED`

### Requirement: Cross-user access returns 404

For any backup-scoped route, if the requested resource exists but belongs to a different user, the system SHALL return HTTP 404 — never 403 — to avoid leaking the existence of other users' resources.

#### Scenario: Cross-user backup read returns 404
- **WHEN** authenticated user A requests `GET /api/backups/<backupId-owned-by-user-B>/versions`
- **THEN** the response is HTTP 404 and `error.code` is `NOT_FOUND`

#### Scenario: Cross-user version delete returns 404
- **WHEN** authenticated user A requests `DELETE /api/backups/<backupId-owned-by-B>/versions/<versionId>`
- **THEN** the response is HTTP 404 and `error.code` is `NOT_FOUND`

### Requirement: Version creation mints presigned uploads

`POST /api/backups/:backupId/versions` SHALL accept `{ encryptedManifest, chunkMetadata: [{ index, encryptedSize, sha256 }] }` and SHALL return `{ versionId, uploadUrls: [{ chunkIndex, presignedUrl, expiresAt }] }`. Each presigned URL MUST be a PUT scoped to a single R2 object key with a TTL of 300 seconds. The endpoint MUST require `subscriptionStatus = "active"`.

#### Scenario: Active user creates a version and gets per-chunk presigned PUTs
- **WHEN** an authenticated active user POSTs a valid version-creation payload with N chunks
- **THEN** the response is HTTP 200, `uploadUrls.length == N`, AND every entry has a `presignedUrl` whose `X-Amz-Expires` (or equivalent) is 300

#### Scenario: Version creation fails when over quota
- **WHEN** the sum of `size_bytes` across the user's existing non-deleted versions plus the new version's `size_bytes` exceeds the quota
- **THEN** the response is HTTP 413 and `error.code` is `STORAGE_QUOTA_EXCEEDED`

### Requirement: Version retention soft-deletes the oldest beyond five

After a successful version creation, the system SHALL soft-delete (set `deleted_at`) any version of that backup beyond the most recent five non-deleted versions.

#### Scenario: Sixth version soft-deletes the oldest
- **GIVEN** a backup with five non-deleted versions
- **WHEN** the user creates a sixth version
- **THEN** the response is HTTP 200, the new version row is created, AND the oldest of the original five has `deleted_at IS NOT NULL`

#### Scenario: Soft-deleted version is not visible in list
- **GIVEN** a version that has been soft-deleted
- **WHEN** the user requests `GET /api/backups/:backupId/versions`
- **THEN** the soft-deleted version does not appear in the response

### Requirement: Soft-deletion semantics

`DELETE /api/backups/:backupId/versions/:versionId` SHALL set `deleted_at` to `now()` and return HTTP 200. The row remains for 7 days before R2 garbage collection. Read paths (`GET .../versions`, `POST .../download-urls`) SHALL exclude soft-deleted versions. The DELETE endpoint is allowed in `active`, `grace`, and `cancelled`.

#### Scenario: Soft-delete persists the row but hides it
- **WHEN** the user soft-deletes a version
- **THEN** the response is HTTP 200, the row's `deleted_at` is non-null, AND subsequent `GET` and download-URL requests treat the version as not found (404)

### Requirement: Download URLs

`POST /api/backups/:backupId/versions/:versionId/download-urls` SHALL accept `{ chunkIndices: number[] }` and SHALL return `{ urls: [{ chunkIndex, presignedUrl, expiresAt }] }` with 300-second presigned GETs. The endpoint MUST allow `active`, `grace`, and `cancelled` and MUST block `none`.

#### Scenario: Download URLs are scoped per chunk
- **WHEN** an authenticated user with read access posts `{ chunkIndices: [0, 1, 2] }`
- **THEN** the response contains exactly three entries, each scoped to the chunk's R2 object key

#### Scenario: Download URLs blocked when status is `none`
- **WHEN** the user has `subscriptionStatus = "none"`
- **THEN** the response is HTTP 402 and `error.code` is `SUBSCRIPTION_REQUIRED`

### Requirement: Hard delete of a backup cascades

`DELETE /api/backups/:backupId` SHALL remove the `backups` row, which cascades via foreign key to `backup_versions` and `backup_chunks`. The R2 prefix is marked for asynchronous purge.

#### Scenario: Backup delete cascades in Postgres
- **WHEN** the user deletes a backup that has versions and chunks
- **THEN** the response is HTTP 200, AND no rows for that `backup_id` remain in `backups`, `backup_versions`, or `backup_chunks`

### Requirement: API version header

Every JSON response from `/api/backups/*` SHALL include the `X-Endstate-API-Version: 1.0` header.

#### Scenario: Storage routes emit the version header
- **WHEN** any `/api/backups/*` route returns a JSON response
- **THEN** the response includes header `X-Endstate-API-Version: 1.0`
