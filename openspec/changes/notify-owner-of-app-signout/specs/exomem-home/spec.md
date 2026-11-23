## ADDED Requirements

### Requirement: Home's app rows say whether each app can still reach the Exomem

Each connected app row SHALL say whether the app can still reach the Exomem,
computed at render time from the database: signed in when a token family
under the grant is unrevoked and unexpired, else signed out with the day the
last live family ended and the remedy "Open `<app>` and connect Exomem
again". A row whose state cannot be read SHALL show unknown, never signed
in. Every row's state SHALL come from the one list query.

#### Scenario: App is signed in

- **WHEN** the app's grant has at least one unrevoked, unexpired token family
- **THEN** the row reads "signed in" with its connected and used dates

#### Scenario: Every family ended

- **WHEN** no family under the app's grant is unrevoked and unexpired
- **THEN** the row reads "signed out since `<date>`" or "signed out" and tells
  the owner to open the app and connect Exomem again

#### Scenario: State cannot be read

- **WHEN** the row's sign-in state is absent or unreadable
- **THEN** the row shows unknown and never claims the app is signed in
