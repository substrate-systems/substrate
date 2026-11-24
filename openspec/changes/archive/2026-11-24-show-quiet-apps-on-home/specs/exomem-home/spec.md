## ADDED Requirements

### Requirement: Home names a signed-in app that has gone quiet

A connected app row that reads signed in SHALL say "not used since `<date>`" and "reconnect it in the app if that's unexpected" when the app's last recorded use is at least three days (72 hours) before the reader's current time, computed at render time. The date SHALL be the last recorded use, in the reader's time zone. A row without a readable last use SHALL NOT make this claim. The line SHALL NOT sign the app out, send an email, or add a query to the app list.

#### Scenario: Signed-in app unused for three days

- **WHEN** a signed-in app's last recorded use is 72 hours or more ago
- **THEN** the row reads "not used since `<date>`" and "reconnect it in the app if that's unexpected" instead of "used `<date>`"

#### Scenario: Weekend gap

- **WHEN** a signed-in app's last recorded use is three calendar days ago but less than 72 hours ago
- **THEN** the row reads "used `<date>`"

#### Scenario: No recorded use

- **WHEN** a signed-in app has no recorded last use
- **THEN** the row says nothing about use and makes no quiet claim

#### Scenario: Not signed in

- **WHEN** the app's row reads signed out or sign-in unknown
- **THEN** the row keeps that state's copy, whatever the last use
