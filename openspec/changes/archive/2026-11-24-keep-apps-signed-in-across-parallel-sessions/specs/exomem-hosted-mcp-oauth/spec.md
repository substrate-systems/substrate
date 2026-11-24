## MODIFIED Requirements

### Requirement: Token Families Provide Durable Revocable Continuity

The authorization server SHALL issue high-entropy opaque authorization codes, short-lived access tokens, and one-time rotating refresh tokens while storing only their digests. Every token MUST be bound to the Exomem issuer, exact MCP resource audience, client, identity, grant, scopes, and token family. Access tokens SHALL expire one hour after issuance, and the token endpoint MUST report that lifetime as `expires_in`. Access checks SHALL enforce current grant, entitlement, tenant, and explicit account/lifecycle policy; transient cell readiness MUST NOT revoke or prevent an otherwise valid ordinary refresh. Forwarding a call SHALL separately require the tenant's cell to be running or read-only. Refresh tokens SHALL slide: each rotation renews a configurable idle window, bounded by a configurable absolute family ceiling and any reviewer credential expiry. All three limits are operator configuration with secure maximums. An unset value uses the default; a value that is not a whole number in range MUST log a warning and use the default for the idle window and the family ceiling, and 0 for the reuse interval; a value above the maximum MUST log a warning and use the maximum. A spent refresh token presented again by its own client within a bounded, configurable reuse interval (seven days by default, at most thirty) SHALL receive a fresh pair in the same family without revoking it, while the family and grant are unrevoked and the family is unexpired. The client identifier is public and does not authenticate the presenter, so each such reuse starts an independent chain that only a family or grant revocation ends. One spent token SHALL mint at most sixty-four children — the one its spend created plus at most sixty-three reuses — after which presentations are refused while the family stays live; this is a loop guard for a stuck client, not a theft bound, since only family or grant revocation ends what a stolen token starts. A spent token inside the reuse interval SHALL count as live for the refetch of a self-registering client's lapsed metadata, under the same client, family and grant checks. A spent token presented after the reuse interval MUST be refused without revoking the family, and the refusal MUST be logged distinctly with the token's age since its spend; raw credentials MUST NOT be logged or persisted, and no earlier replacement token is recoverable.

#### Scenario: Client restarts after initial login

- **WHEN** a valid refresh token is used after the client or conversation restarts
- **THEN** the server atomically rotates it and returns a new one-hour access token plus replacement refresh token
- **AND** the user is not asked to log in again during the configured valid family lifetime

#### Scenario: Active client stays signed in until the family ceiling

- **WHEN** a client refreshes at least once within each idle window
- **THEN** each replacement refresh token expires one idle window after it is issued
- **AND** no refresh token expires later than the family ceiling, after which the client must authorize again

#### Scenario: Idle client must authorize again

- **WHEN** a client presents a refresh token after its idle window has passed
- **THEN** the refresh fails and the user authorizes the client again

#### Scenario: Same client retries a spent refresh token inside the reuse interval

- **WHEN** a client presents a refresh token that was spent less than the reuse interval ago — days after the spend, not only seconds — because a reply was lost or a parallel session shared the credential
- **THEN** the server returns a fresh access token plus refresh token in the same family
- **AND** the family and grant remain unrevoked, and the same admission checks apply as for a first rotation

#### Scenario: Each reuse starts a bounded chain

- **WHEN** one spent refresh token is presented more than once inside the reuse interval
- **THEN** each presentation returns its own pair, and each pair's refresh token rotates and slides independently up to the family ceiling
- **AND** the spent token mints at most sixty-four children in total; once the guard is reached, further presentations are refused, and only revoking the family or grant ends the existing chains

#### Scenario: Two simultaneous presentations of one refresh token

- **WHEN** one client presents the same refresh token twice at the same moment
- **THEN** both calls return working tokens and the family is not revoked

#### Scenario: Reuse interval is turned off

- **WHEN** the reuse interval is configured as zero, or as a value that is not a whole number in range
- **THEN** any presentation of a spent refresh token is refused without revoking the family

#### Scenario: Stale presentation after the reuse interval

- **WHEN** a consumed refresh token is presented after the reuse interval has passed
- **THEN** the presentation is refused with `invalid_grant` and the refusal is logged with the token's age since its spend
- **AND** the token family is NOT revoked, and the family's other live tokens keep working

#### Scenario: Spent refresh token is presented by another client

- **WHEN** a client other than the token's own presents a consumed refresh token
- **THEN** the server returns no tokens and creates no token or grant row

#### Scenario: One client family is revoked

- **WHEN** the user or operator revokes one Claude or OpenAI client authorization
- **THEN** that family's access and refresh tokens fail centrally
- **AND** a separately authorized client family remains usable unless account-wide policy also denies it

#### Scenario: Access token has wrong audience or scope

- **WHEN** a valid-looking token was not issued for an accepted Exomem Cloud MCP resource, or lacks `exomem.read` or `exomem.write`
- **THEN** the gateway answers `401` for the wrong resource and `403` `INSUFFICIENT_SCOPE` for a missing scope, before any cell contact
