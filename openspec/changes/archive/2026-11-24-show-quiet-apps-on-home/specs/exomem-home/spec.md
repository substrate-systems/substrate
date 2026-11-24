## ADDED Requirements

### Requirement: Home names a signed-in app that has gone quiet

While the cell serves app calls, a signed-in app row SHALL read "not used since `<date>`" and "reconnect it in the app if that’s unexpected" once its last recorded use is 72 hours old, computed at render time. A row without a readable last use SHALL NOT make this claim, and the line SHALL NOT sign the app out, send an email or add a query.

#### Scenario: Signed-in app unused for three days

- **WHEN** a signed-in app's last recorded use is 72 hours or more ago
- **THEN** the row reads "not used since `<date>`" and "reconnect it in the app if that’s unexpected" instead of "used `<date>`"

#### Scenario: Weekend gap

- **WHEN** a signed-in app's last recorded use is three calendar days ago but less than 72 hours ago
- **THEN** the row reads "used `<date>`"

#### Scenario: No recorded use

- **WHEN** a signed-in app has no recorded last use
- **THEN** the row says nothing about use and makes no quiet claim

#### Scenario: Cell serves no calls

- **WHEN** the cell is paused, suspended or otherwise not serving app calls
- **THEN** the row reads "used `<date>`" and makes no quiet claim, since the gateway records no use while it refuses calls

#### Scenario: Not signed in

- **WHEN** the app's row reads signed out or sign-in unknown
- **THEN** the row keeps that state's copy, whatever the last use
