# exomem-hosted-access Specification

## Purpose

Define invite-only hosted access, product-scoped browser sessions, account privacy, and the path from authentication to a useful first memory.

## Requirements

### Requirement: Exomem access is invite only during alpha

The system SHALL allow only an authenticated operator to create an Exomem alpha invite. Each invite MUST be bound to one normalized email address, an entitlement source, an expiration, and a single high-entropy token whose digest rather than plaintext is stored.

#### Scenario: Operator creates a complimentary invite

- **WHEN** an operator with valid Exomem invite authority creates an unexpired complimentary invite for an email address
- **THEN** the system stores a single-use digest-bound invite and returns or delivers one redemption URL
- **AND** the plaintext token is not written to logs or retained in the database

#### Scenario: Public caller attempts to create an invite

- **WHEN** a caller without operator authority invokes the invite creation boundary
- **THEN** the system rejects the request without revealing invite or account state

### Requirement: Invite redemption is email bound, atomic, and idempotent

Redeeming a valid invite SHALL atomically consume that invite, resolve or create the shared identity for its bound email, resolve or create exactly one Exomem tenant owned by that identity, project the invite entitlement, and create an Exomem product session. The caller MUST NOT replace the bound email or choose a tenant during redemption.

#### Scenario: New invitee redeems a valid invite

- **WHEN** a user accepts the displayed bound email and redeems a valid unused invite before expiry
- **THEN** the system creates or resolves one identity, one Exomem tenant, one entitlement, and one product session
- **AND** repeated delivery or database retry converges without creating a second tenant

#### Scenario: Consumed or expired invite is replayed

- **WHEN** a consumed, revoked, malformed, or expired invite token is presented
- **THEN** redemption fails with a stable non-enumerating error
- **AND** no session, tenant, entitlement, or provisioning operation is created

#### Scenario: Caller attempts to replace the invite email

- **WHEN** a redemption request includes an email different from the invite's bound email
- **THEN** the supplied email is ignored or rejected
- **AND** no identity or tenant is created for the supplied address

### Requirement: Exomem browser sessions are product scoped and revocable

The system SHALL issue Exomem-specific opaque browser sessions using secure cookie attributes, store only a digest of each session secret, enforce expiration and revocation, and keep those sessions independent from Endstate account sessions.

#### Scenario: Signed-in user opens Exomem Home

- **WHEN** a request carries a valid unexpired Exomem session cookie
- **THEN** the system resolves exactly one user identity and permits product-scoped Home access
- **AND** the response does not expose the session secret, internal user ID, tenant ID, or cell credential

#### Scenario: Session is missing, expired, or revoked

- **WHEN** a protected Exomem route receives no valid Exomem session
- **THEN** it fails closed or redirects to the Exomem sign-in experience
- **AND** an Endstate session alone does not authorize Exomem

#### Scenario: User signs out

- **WHEN** a signed-in user completes a CSRF-valid sign-out
- **THEN** the server revokes the stored session and clears the browser cookie
- **AND** replaying the former cookie does not restore access

### Requirement: Browser mutations resist cross-site request forgery

Every cookie-authenticated state-changing Exomem browser route MUST validate same-origin request context and a session-bound CSRF value. Read-only navigation MUST NOT mutate tenant, billing, transfer, or lifecycle state.

#### Scenario: Valid same-origin capture

- **WHEN** a signed-in Home client sends a same-origin request with its valid CSRF value
- **THEN** the mutation may continue through the normal entitlement and gateway checks

#### Scenario: Cross-site request attempts a mutation

- **WHEN** a valid session cookie accompanies a mutation with a missing or conflicting origin or CSRF value
- **THEN** the system rejects it before issuing a cell, Paddle, transfer, or lifecycle request

### Requirement: Existing users can request a non-enumerating sign-in link

An identity that already owns an active Exomem tenant SHALL be able to request a short-lived, single-use sign-in link by email. The public response MUST be indistinguishable for known and unknown addresses, and requesting a link MUST NOT create an account or tenant.

#### Scenario: Existing Exomem owner requests a link

- **WHEN** an existing owner submits their normalized email within rate limits
- **THEN** the system sends a short-lived single-use sign-in link and returns the generic acknowledgement

#### Scenario: Unknown address requests a link

- **WHEN** an address with no Exomem tenant submits the same request
- **THEN** the system returns the same generic acknowledgement without creating identity, tenant, entitlement, or email disclosure

### Requirement: One identity owns at most one Exomem tenant in the alpha

The control plane SHALL enforce one owner-to-tenant mapping per identity and SHALL reject ambiguous ownership rather than selecting a default or most recently used tenant.

#### Scenario: Concurrent redemption targets one identity

- **WHEN** concurrent valid operations attempt to create an Exomem tenant for the same user identity
- **THEN** the database converges on one tenant and both operations resolve that tenant or one receives a stable conflict

#### Scenario: Ownership lookup is ambiguous

- **WHEN** control-plane state would resolve an authenticated owner to zero or more than one active tenant
- **THEN** protected routing fails closed with a content-free stable error

### Requirement: Invitation and sign-in surfaces preserve account privacy

Public access responses and operational logs MUST NOT reveal whether an email has an account, and MUST NOT include invite tokens, sign-in tokens, session secrets, cell credentials, or raw email where an opaque reference suffices.

#### Scenario: Sensitive access sentinel reaches an error path

- **WHEN** an invite, sign-in, or session operation fails while carrying a sensitive sentinel
- **THEN** application logs and returned diagnostics omit the token or secret
- **AND** public responses disclose no additional account-existence information

### Requirement: Successful onboarding reaches a useful memory flow

After valid invite redemption, the system SHALL show deterministic provisioning progress and SHALL lead a ready tenant through one capture followed by one recall without requiring local installation, GitHub, Markdown, MCP, vault paths, or billing details for a complimentary invite.

#### Scenario: Cell becomes ready normally

- **WHEN** an invited user's cell reaches ready state within the target window
- **THEN** Home offers a plain-language first capture and immediate recall flow
- **AND** the user can complete it without encountering infrastructure or schema terminology

#### Scenario: Provisioning is delayed

- **WHEN** the cell is not yet ready
- **THEN** Home displays a content-free progress state, automatically refreshes, and offers a request ID for support
- **AND** it does not accept a write that could be lost or routed elsewhere
