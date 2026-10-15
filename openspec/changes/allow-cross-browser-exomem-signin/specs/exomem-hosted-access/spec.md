# Spec Delta

## ADDED Requirements

### Requirement: Sign-in links can complete in another browser

The system SHALL accept a single-use sign-in link in another browser after the person confirms its account email. The server MUST check that email before consuming the token or creating a session. Matching browser proof SHALL retain the email-free path. A supplied email MUST always be checked. Email confirmation checks account intent, not another factor.

#### Scenario: Original browser completes sign-in

- **WHEN** the person explicitly continues with a valid link and matching browser proof
- **THEN** only that browser receives a product session without an email prompt
- **AND** its live OAuth continuation remains available

#### Scenario: Another browser completes sign-in

- **WHEN** the browser lacks matching proof and the person submits the correct account email with a valid link
- **THEN** the server atomically consumes the link and creates one session for the completing browser
- **AND** it opens Home without carrying any other OAuth continuation
- **AND** the requesting browser receives no session

#### Scenario: Email is required without disclosing token state

- **WHEN** a redemption without email cannot authenticate through browser proof
- **THEN** it asks for email without revealing token validity or the target address
- **AND** an existing recovery receipt retains its current limited recovery authority

#### Scenario: Wrong email leaves a valid link usable

- **WHEN** the supplied email differs from the authoritative account address, even with matching browser proof
- **THEN** the server returns a generic failure without consuming the link or creating a session
- **AND** a corrected attempt can succeed

#### Scenario: Navigation or invalid redemption cannot authenticate

- **WHEN** a link is prefetched or opened without explicit confirmation, or redemption fails origin or input validation
- **THEN** no session is created and no valid token is consumed

#### Scenario: Token safeguards remain in force

- **WHEN** the link is expired, revoked, consumed, superseded, undelivered or bound to an unavailable or different tenant
- **THEN** email confirmation cannot authenticate it
- **AND** concurrent successful attempts create at most one session
