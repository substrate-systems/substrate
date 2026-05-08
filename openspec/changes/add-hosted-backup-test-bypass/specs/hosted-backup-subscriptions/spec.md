## ADDED Requirements

### Requirement: Operator-controlled test-email bypass on write endpoints

The system SHALL support an operator-controlled bypass of the write-path
subscription gate, scoped to email addresses matching a regex configured via
the `HOSTED_BACKUP_TEST_EMAIL_PATTERN` environment variable. The bypass exists
to enable end-to-end engine smoke tests to run against production without
going through Paddle checkout for each test account. It SHALL NOT apply to
read endpoints, and it SHALL have no effect when the env var is empty or
unset.

The bypass is enforced inside `requireWriteAccess` after JWT validation and
before the live `subscriptions` table check. When a bypass is taken, the
authenticated context is returned without consulting the `subscriptions`
row; downstream route handlers proceed as if the user had `status = "active"`.

#### Scenario: env var unset — bypass disabled, user with status none is rejected
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is empty or unset
- **AND** a user `u-1` whose `subscriptions.status` is `"none"`
- **WHEN** `u-1` calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: env var set, email matches — user with status none is allowed
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user `u-2` with email `smoketest+1@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** `u-2` calls `POST /api/backups`
- **THEN** the response is HTTP 200 (the request is processed as if the user had an active subscription)

#### Scenario: env var set, email does not match — user with status none is still rejected
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user `u-3` with email `alice@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** `u-3` calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: invalid regex source — bypass disabled, every user is gated normally
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is a value that is not a valid `RegExp` source (e.g., `"["`)
- **AND** any user with `subscriptions.status = "none"`, regardless of email
- **WHEN** the user calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`
- **AND** a single warning per process per env-var value is logged indicating the bypass is disabled

#### Scenario: bypass does not apply to read endpoints
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user with email `smoketest+1@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** the user calls a read endpoint such as `GET /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED` (the bypass is intentionally write-only)

#### Scenario: bypass usage is logged for audit
- **GIVEN** any request whose user matches the configured bypass pattern
- **WHEN** the bypass is taken
- **THEN** a structured log line is emitted that identifies the user id and indicates the subscription gate was bypassed
- **AND** the line is sufficient for an operator to enumerate which accounts have used the bypass during a given period
