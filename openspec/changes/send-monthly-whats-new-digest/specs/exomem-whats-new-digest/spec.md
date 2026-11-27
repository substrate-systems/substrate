## ADDED Requirements

### Requirement: The month's changes are picked from every release of the month

The system SHALL select, from the user notes of all of a month's releases, at most 6 changes that a typical owner would notice, ranked. When fewer than 3 changes qualify, the system SHALL select none and send no digest that month.

#### Scenario: A month with many changes

- **WHEN** a month's releases carry 100 user notes
- **THEN** the selection holds between 3 and 6 of them

#### Scenario: A quiet month

- **WHEN** fewer than 3 of a month's notes would interest a typical owner
- **THEN** no owner receives a digest for that month

### Requirement: The digest shows each change as its note

The digest SHALL show each selected change as its note's own title and sentence, and a note without a title as its sentence alone.

#### Scenario: A note without a title

- **WHEN** a selected note has no title
- **THEN** the digest shows its sentence alone

### Requirement: Missing release notes stay visible

The system SHALL treat a release whose notes cannot be read as notes missing, never as no notes. The approval page SHALL name each such release.

#### Scenario: One release lacks its notes

- **WHEN** one of the month's releases has no readable notes
- **THEN** the approval page names that release, and the next daily run tries it again

### Requirement: Each owner receives at most one digest a month, about what their cell runs

The system SHALL queue at most one digest per owner and month, with only selected changes from releases at or below the owner's cell's running release. The system MUST NOT send a digest to a reviewer account, to an owner whose running release is unknown or whose cell is not running, or to an owner left with fewer than 3 changes.

#### Scenario: An owner whose cell lags

- **WHEN** the selection includes a change from a release newer than the owner's cell runs
- **THEN** that owner's digest leaves the change out

#### Scenario: The route runs again

- **WHEN** the daily route runs again for a month it already queued
- **THEN** no owner receives a second digest

### Requirement: Digests never delay other email

Digest emails SHALL have the lowest send priority of all outbox kinds, and the system SHALL queue them in bounded passes.

#### Scenario: A payment email during the digest send

- **WHEN** a payment-failed email is queued while digests are still waiting to send
- **THEN** the payment-failed email is sent before the remaining digests

### Requirement: An owner can stop the digest in one step

Every digest SHALL carry the `List-Unsubscribe` and `List-Unsubscribe-Post` headers and a link to an unsubscribe page. Only a POST SHALL change the setting. The unsubscribe and Home's "Monthly update email" setting SHALL change the same value. The system MUST NOT send a digest to an owner whose setting is off at send time.

#### Scenario: One-click unsubscribe

- **WHEN** an owner's mail client sends the one-click unsubscribe POST
- **THEN** the setting is off, Home shows it off, and no later digest is sent

#### Scenario: A link scanner opens the link

- **WHEN** a link scanner sends a GET request to the unsubscribe link
- **THEN** the setting is unchanged

#### Scenario: Turned off while queued

- **WHEN** an owner turns the setting off after the month's digest was queued but before it was sent
- **THEN** the digest is not sent

### Requirement: The operator approves the pick until a measurement replaces approval

The system MUST NOT queue a month's digests before the operator approves that month's selection, for at least the first three months.

#### Scenario: Before approval

- **WHEN** the daily route runs while the month's selection waits for approval
- **THEN** it queues no email
