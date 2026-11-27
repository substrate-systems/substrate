## ADDED Requirements

### Requirement: Signup offers the opt-out from the monthly update email

The signup SHALL tell a new owner that they will receive the monthly update email and SHALL let them opt out before the account is created. The owner's "Monthly update email" setting SHALL start on, unless they opted out.

#### Scenario: A new owner opts out at signup

- **WHEN** a new owner opts out of the monthly update email at signup
- **THEN** their setting starts off, and Home shows no invitation to turn it on

#### Scenario: A new owner keeps the email

- **WHEN** a new owner completes signup without opting out
- **THEN** their setting starts on
