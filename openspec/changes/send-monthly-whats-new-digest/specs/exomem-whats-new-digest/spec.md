## ADDED Requirements

### Requirement: The month's changes are picked once, and only when enough clear the bar

The system SHALL, once a month, select from the user notes of that month's releases at most 6 changes that a typical owner would notice, ranked. The email SHALL show each selected note's own title and sentence. When fewer than 3 changes qualify, the system SHALL select none and send no digest that month.

#### Scenario: A month with many changes

- **WHEN** a month's releases carry 40 user notes
- **THEN** the selection holds between 3 and 6 of them, each shown as its note's title and sentence

#### Scenario: A quiet month

- **WHEN** fewer than 3 of a month's notes would interest a typical owner
- **THEN** no owner receives a digest for that month

### Requirement: Each owner receives at most one digest a month, about what their cell runs

The system SHALL queue at most one digest per owner and month. The digest SHALL list only selected changes from releases at or below the owner's cell's running release, and SHALL link to Home. The system MUST NOT send a digest to a reviewer account, to an owner whose cell is not running, or to an owner left with fewer than 3 changes.

#### Scenario: An owner whose cell lags

- **WHEN** the selection includes a change from a release newer than the owner's cell runs
- **THEN** that owner's digest leaves the change out

#### Scenario: The cron route runs twice

- **WHEN** the monthly route runs a second time for the same month
- **THEN** no owner receives a second digest

### Requirement: An owner can stop the digest in one step

Every digest SHALL carry a one-click unsubscribe link and the `List-Unsubscribe` and `List-Unsubscribe-Post` headers. The link and Home's "Monthly update email" setting SHALL change the same value. The system MUST NOT send a digest to an owner whose setting is off at send time.

#### Scenario: Unsubscribe from the email

- **WHEN** an owner follows the unsubscribe link
- **THEN** the setting is off, Home shows it off, and no later digest is sent

#### Scenario: Turned off while queued

- **WHEN** an owner turns the setting off after the month's digest was queued but before it was sent
- **THEN** the digest is not sent

### Requirement: The first digest waits for the operator

The system MUST NOT send any digest until the operator has approved the first month's selection and rendered email.

#### Scenario: Before approval

- **WHEN** the monthly route runs before the operator's approval
- **THEN** it records the selection and queues no email
