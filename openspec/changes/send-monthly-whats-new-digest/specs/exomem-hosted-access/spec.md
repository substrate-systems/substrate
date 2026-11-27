## ADDED Requirements

### Requirement: Signup offers the opt-out from the monthly update email

The signup SHALL tell a new owner that they will receive the monthly update email and SHALL let them opt out before the account is created. The owner's "Monthly update email" setting SHALL start on when the signup showed that switch and the owner left it on. A signup request that does not state the choice SHALL start the setting off.

#### Scenario: A new owner opts out at signup

- **WHEN** a new owner opts out of the monthly update email at signup
- **THEN** their setting starts off, and Home shows no invitation to turn it on

#### Scenario: A new owner keeps the email

- **WHEN** a new owner completes signup without opting out
- **THEN** their setting starts on

#### Scenario: A client that does not state the choice

- **WHEN** a signup request carries no choice for the monthly update email
- **THEN** the owner's setting starts off
