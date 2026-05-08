## MODIFIED Requirements

### Requirement: Operator-controlled test-email bypass on read and write endpoints

The system SHALL support an operator-controlled bypass of the
subscription gate, scoped to email addresses matching a regex configured
via the `HOSTED_BACKUP_TEST_EMAIL_PATTERN` environment variable. The
bypass exists to enable end-to-end engine smoke tests (`signup → push →
pull → byte-equal → delete`) to run against production without going
through Paddle checkout for each disposable test account. The bypass
SHALL apply symmetrically to both write endpoints (`requireWriteAccess`)
and read endpoints (`requireReadAccess`); the previously-documented
write-only scope is replaced because the smoke-test pull step inherently
requires read access. The bypass SHALL have no effect when the env var
is empty or unset.

The bypass is enforced inside each gate function after JWT validation
and before the live `subscriptions` table check. When a bypass is
taken, the authenticated context is returned without consulting the
`subscriptions` row; downstream route handlers proceed as if the user
had `status = "active"`.

The bypass is safe because it is gated by two operator-controlled
conditions:

1. The `HOSTED_BACKUP_TEST_EMAIL_PATTERN` env var is set in Vercel
   project settings; anyone with permission to set it already has full
   admin control of substrate.
2. The user's stored email (captured at signup) matches the compiled
   regex. The recommended pattern, `^smoketest\+\d+@example\.com$`,
   uses the RFC 2606 reserved `example.com` domain — no organic signup
   could match.

Each request that takes the bypass SHALL emit a structured warning log
identifying the user id, so the bypass usage is auditable and an
unexpected spike is detectable in Vercel runtime logs.

#### Scenario: env var unset — bypass disabled, user with status none is rejected on writes
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is empty or unset
- **AND** a user `u-1` whose `subscriptions.status` is `"none"`
- **WHEN** `u-1` calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: env var unset — bypass disabled, user with status none is rejected on reads
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is empty or unset
- **AND** a user `u-1r` whose `subscriptions.status` is `"none"`
- **WHEN** `u-1r` calls `GET /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: env var set, email matches — user with status none is allowed on writes
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user `u-2` with email `smoketest+1@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** `u-2` calls `POST /api/backups`
- **THEN** the response is HTTP 200

#### Scenario: env var set, email matches — user with status none is allowed on reads
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user `u-2r` with email `smoketest+1@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** `u-2r` calls `GET /api/backups`
- **THEN** the response is HTTP 200

#### Scenario: env var set, email does not match — user with status none is rejected on writes
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user `u-3` with email `alice@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** `u-3` calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: env var set, email does not match — user with status none is rejected on reads
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN = "^smoketest\\+\\d+@example\\.com$"`
- **AND** a user `u-3r` with email `alice@example.com` whose `subscriptions.status` is `"none"`
- **WHEN** `u-3r` calls `GET /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: invalid regex source — bypass disabled, every user is gated normally on writes
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is a value that is not a valid `RegExp` source (e.g., `"["`)
- **AND** any user with `subscriptions.status = "none"`, regardless of email
- **WHEN** the user calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`
- **AND** a single warning per process per env-var value is logged indicating the bypass is disabled

#### Scenario: invalid regex source — bypass disabled, every user is gated normally on reads
- **GIVEN** `HOSTED_BACKUP_TEST_EMAIL_PATTERN` is a value that is not a valid `RegExp` source (e.g., `"["`)
- **AND** any user with `subscriptions.status = "none"`, regardless of email
- **WHEN** the user calls `GET /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED`

#### Scenario: bypass usage is logged for audit
- **GIVEN** any request whose user matches the configured bypass pattern (read or write)
- **WHEN** the bypass is taken
- **THEN** a structured log line is emitted that identifies the user id and indicates the subscription gate was bypassed
- **AND** the line is sufficient for an operator to enumerate which accounts have used the bypass during a given period
