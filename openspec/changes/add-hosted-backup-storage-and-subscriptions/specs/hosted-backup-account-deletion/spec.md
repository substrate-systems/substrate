## ADDED Requirements

### Requirement: Account delete endpoint

The system SHALL expose `DELETE /api/account`, auth-gated, that hard-deletes the authenticated user's data from Postgres, cancels their Paddle subscription (best-effort), records an audit-log row, and marks their R2 prefix for asynchronous purge.

#### Scenario: Deletion removes all Postgres rows for the user
- **GIVEN** an authenticated user with rows in `users`, `auth_credentials`, `refresh_tokens`, `subscriptions`, `backups`, `backup_versions`, `backup_chunks`
- **WHEN** the user calls `DELETE /api/account`
- **THEN** the response is HTTP 200 with body `{ ok: true }` AND no rows remain for that `user_id` in any of the listed tables

#### Scenario: Deletion writes an audit-log row
- **WHEN** an account is deleted
- **THEN** a row exists in `audit_log_account_deletions` with `user_id_hash = SHA-256(<userId-utf8>)`, `deleted_at = now()`, AND `reason = "user_request"`

#### Scenario: Audit log uses SHA-256, not raw UUID
- **WHEN** an account is deleted
- **THEN** the `user_id_hash` column is exactly 32 bytes (the SHA-256 digest length) AND no column in `audit_log_account_deletions` contains the raw user UUID

### Requirement: Paddle cancel is best-effort

If the Paddle subscription cancel call fails (network error, unknown subscription, Paddle API down), the system SHALL log the failure and continue with the Postgres cascade. The endpoint MUST NOT return non-2xx solely because of a Paddle cancel failure.

#### Scenario: Paddle cancel failure does not block deletion
- **GIVEN** a user with an `active` Paddle subscription whose cancel call will fail
- **WHEN** the user calls `DELETE /api/account`
- **THEN** the response is HTTP 200 with body `{ ok: true }` AND all the user's Postgres rows are deleted AND a `console.error` entry mentions the cancel failure

### Requirement: R2 prefix marked for async purge

The system SHALL record the R2 object-key prefix `users/<userId>/` for asynchronous purge as part of the deletion flow. Synchronous purge is not required for the response.

#### Scenario: Deletion marks the R2 prefix without blocking the response
- **WHEN** an account is deleted
- **THEN** the response returns within a normal request budget (no synchronous R2 list-and-delete) AND the prefix is recorded somewhere a future cron job can pick it up (e.g. the audit log itself or a deletion queue)

### Requirement: Active session is invalidated

After deletion, the user's existing access tokens SHALL fail to authenticate any subsequent request because their `users` row is gone.

#### Scenario: Pre-deletion access token no longer authenticates
- **GIVEN** a user with a fresh access token
- **WHEN** the user deletes their account THEN attempts a request to any auth-gated route
- **THEN** the request fails with HTTP 401 (because the underlying user row is deleted)

### Requirement: API version header

`DELETE /api/account` responses SHALL include `X-Endstate-API-Version: 1.0`.

#### Scenario: Account deletion response is versioned
- **WHEN** the deletion endpoint returns a response
- **THEN** the response includes header `X-Endstate-API-Version: 1.0`
