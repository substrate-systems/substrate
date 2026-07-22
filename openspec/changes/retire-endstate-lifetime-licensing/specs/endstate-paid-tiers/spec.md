# Endstate paid tiers

## ADDED Requirements

### Requirement: Paid offers are Supporter and Hosted Backup only

The website MUST NOT offer or process an Endstate lifetime license. The paid
Endstate offers are the recognition-only Supporter tier and the Hosted Backup
subscription.

#### Scenario: Supporter purchase completes

- **GIVEN** a signed `transaction.completed` event containing the configured
  Supporter price
- **WHEN** it reaches `/api/license/webhook`
- **THEN** the Supporter acknowledgement flow runs
- **AND** no license key is created

#### Scenario: An unhandled one-time purchase completes

- **GIVEN** a valid signed `transaction.completed` event that does not contain
  the configured Supporter price
- **WHEN** it reaches `/api/license/webhook`
- **THEN** the endpoint returns a successful ignored response
- **AND** no license key is created

#### Scenario: Supporter price configuration is missing

- **GIVEN** a valid signed `transaction.completed` event
- **AND** the Supporter price is not configured
- **WHEN** it reaches `/api/license/webhook`
- **THEN** the endpoint returns a retryable server error
- **AND** it does not acknowledge and permanently discard the purchase

### Requirement: Lifetime activation surface is absent

The application MUST NOT expose lifetime-license checkout, minting, activation,
deactivation, or test-email endpoints. It MUST NOT require the retired lifetime
price or license signing-key environment variables.

#### Scenario: Website builds without lifetime-license configuration

- **WHEN** the application is built without lifetime price and signing-key
  environment variables
- **THEN** the build succeeds
- **AND** current Supporter and Hosted Backup checkout paths remain available
