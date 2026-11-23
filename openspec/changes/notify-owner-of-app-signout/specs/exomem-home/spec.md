## ADDED Requirements

### Requirement: Home's app rows say whether each app can still reach the Exomem

Each connected app row SHALL say whether the app can still reach the Exomem,
computed at render time from the database: signed in while a token family
under the grant holds a usable credential, else signed out with the day the
last live family ended and the remedy "Open `<app>` and connect Exomem
again". A row whose state cannot be read SHALL show unknown, never signed
in. Every row's state SHALL come from the one list query.

#### Scenario: App is signed in

- **WHEN** the app's grant has at least one unrevoked token family holding a
  usable credential — an unconsumed, unexpired refresh token, or for a
  family without refresh an unexpired access token
- **THEN** the row reads "signed in" with its connected and used dates

#### Scenario: An unexpired family row whose credential lapsed

- **WHEN** a family's row is unrevoked and unexpired but its last unconsumed
  refresh token has expired
- **THEN** the row does not read signed in

#### Scenario: Every family ended

- **WHEN** no family under the app's grant holds a usable credential
- **THEN** the row reads "signed out since `<date>`" or "signed out" and tells
  the owner to open the app and connect Exomem again

#### Scenario: State cannot be read

- **WHEN** the row's sign-in state is absent or unreadable
- **THEN** the row shows unknown and never claims the app is signed in
