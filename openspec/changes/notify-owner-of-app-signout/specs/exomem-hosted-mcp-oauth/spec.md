## ADDED Requirements

### Requirement: The owner is emailed when Substrate ends an app's sign-in

When the last live token family under an owner's grant ends without the
owner's action and the grant was used within the last 14 days, the system
SHALL email the owner once, naming the app by its Home display name, the day
access ended and how to reconnect. Detection SHALL run in the scheduled
OAuth sweep; each ended family SHALL notify at most once and at most one
email SHALL send per grant per 24 h.

#### Scenario: Refresh replay signs the app out

- **WHEN** a recently used grant's last live family is revoked as
  `refresh_replayed`
- **THEN** the sweep enqueues exactly one email to the owner naming the app
  and the day it signed out

#### Scenario: Repeated sweeps stay idempotent

- **WHEN** the same ended family is seen by a second sweep or a concurrent one
- **THEN** no further marker or email is produced for it

#### Scenario: Owner disconnect sends nothing

- **WHEN** the owner disconnects the app, or its account, cell or lifecycle
  takes the grant with it
- **THEN** no sign-out email is enqueued for that grant

#### Scenario: Quiet app sends nothing

- **WHEN** a grant's last family ends but its last recorded use is older than
  14 days
- **THEN** no email is enqueued for it

#### Scenario: A queued email is re-checked before it sends

- **WHEN** the owner disconnected or the app reconnected after the email was
  enqueued, or the account is gone
- **THEN** the email is cancelled without sending

#### Scenario: A name the app gave itself is marked as its own claim

- **WHEN** the app's display name came from its own client metadata
- **THEN** the email marks the name as the app's own claim, as Home does
