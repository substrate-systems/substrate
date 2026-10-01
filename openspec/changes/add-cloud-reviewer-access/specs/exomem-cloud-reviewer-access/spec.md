## Purpose

Allow directory reviewers to authenticate independently to a dedicated sample Exomem Cloud vault without the publisher's inbox, while keeping normal accounts and retired Hosted credentials outside that authority.

## ADDED Requirements

### Requirement: Explicit isolated reviewer authority

The operator SHALL issue reviewer access only to an existing, explicitly reviewer-purpose Cloud tenant with a live, non-deleted running cell, complimentary active entitlement without payment-provider references and unblocked non-deleted owner. Issuance MUST NOT admit a tenant, change an ordinary tenant's purpose, or allow access to another vault. Normal initial Cloud admission SHALL preserve the invitation's immutable sample purpose, and re-admission SHALL refuse a purpose mismatch in either direction. Credentials SHALL have a distinct immutable Cloud-only kind, an explicit provider and an expiry no more than90days after issuance; normal user sign-in SHALL remain email-link based.

#### Scenario: Dedicated sample vault
- **WHEN** the operator issues access for an eligible sample Cloud tenant
- **THEN** one provider-bound expiring credential is issued without creating or changing a cell

#### Scenario: Runtime health and authority
- **WHEN** access is issued, or an existing credential is used while runtime health changes
- **THEN** issuance requires observed running/ready health, while lifetime authorization checks desired running state and eligibility rather than volatile health; runtime unavailability remains a routing failure, not an identity change

#### Scenario: Personal or ineligible tenant
- **WHEN** issuance targets an ordinary tenant, deleted owner/cell, stopped cell, blocked owner or expired entitlement
- **THEN** issuance is refused without changing tenant purpose or any authorization

#### Scenario: Sample-purpose propagation
- **WHEN** an explicitly sample-purpose invitation is redeemed through either Cloud admission path
- **THEN** a new tenant retains that purpose, while reusing an existing tenant with another purpose is refused without converting it

### Requirement: Independent OAuth sign-in

Reviewers SHALL authenticate without access to the owner's inbox, phone, network or browser session. Redemption SHALL require a same-origin live Cloud-resource OAuth continuation and the matching provider's admitted client. The credential, session and transaction SHALL be atomically bound to the same identity. Hosted provider-review and canary credentials MUST remain unusable under Cloud.

#### Scenario: Fresh reviewer browser
- **WHEN** a reviewer starts OAuth for the correct provider in a fresh browser and enters valid Cloud review credentials
- **THEN** a bounded reviewer session is created for the dedicated sample tenant and the normal consent flow resumes without an email link

#### Scenario: Wrong lineage
- **WHEN** a credential is expired, revoked, Hosted-kind, wrong-provider, or submitted against a different resource, invalid continuation or another credential's bound transaction
- **THEN** authentication is refused without minting or replacing authorization

### Requirement: Reviewer lineage cannot outlive its authority

Every reviewer session, authorization code, grant, token family, refresh token and access token SHALL retain the same credential identity. Redemption, authorization, minting, refresh and Cloud MCP access SHALL reject mismatched, expired or revoked reviewer authority. Session, code and token expiry MUST NOT exceed credential expiry. Rotation and revocation SHALL invalidate all dependent authorization atomically without invalidating the other provider or unrelated ordinary accounts.

Reviewer authority SHALL cease when its sample tenant becomes payment-bearing or otherwise ineligible. Cloud reviewer browser sessions MUST NOT initiate/resume checkout or create a customer portal, including after payment references are attached.

#### Scenario: Expiry and revocation
- **WHEN** review authority expires, rotates or is revoked
- **THEN** its browser sessions, codes, refresh tokens and Cloud MCP access no longer authenticate, including authorization raced with revocation

#### Scenario: Provider independence
- **WHEN** one provider's review authority is revoked
- **THEN** another provider's valid authority and unrelated ordinary user authorization remain usable

#### Scenario: Billing confinement
- **WHEN** a Cloud reviewer session requests checkout or customer-portal access
- **THEN** the request is refused before billing work, and payment-bearing sample state also refuses further reviewer authorization and MCP access

### Requirement: Review access stays private and deployable

Credential values SHALL be delivered only through secure operator custody and reviewer-access fields, never public plugin files, Git, logs, chat or recordings. Operator status SHALL expose no credential values. The existing review form SHALL serve the Cloud path without changing ordinary sign-in or creating a new screen. Flag-off Hosted behavior and ordinary Cloud client admission SHALL remain unchanged.

#### Scenario: Actual directory access
- **WHEN** the delivered review account is tested in a clean browser
- **THEN** it can consent and run the sample bootstrap/capture/readback without owner cookies or inbox access, with credentials absent from public artifacts and the demo
