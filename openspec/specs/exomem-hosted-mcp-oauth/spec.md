# exomem-hosted-mcp-oauth Specification

## Purpose

Define the Exomem Cloud MCP resource as an OAuth-protected resource, the Exomem authorization server, invite-based first login, durable revocable token families, fail-closed revocation, and the owner's notice when Substrate signs an app out.

## Requirements

### Requirement: Public MCP Is A Standards-Compatible Protected Resource

The Exomem Cloud MCP resource SHALL be a Streamable HTTP endpoint at the configured Cloud MCP URL, protected by OAuth. The gateway SHALL serve RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource` followed by the MCP path, naming the Exomem authorization server, header bearer delivery and the supported scopes. The web application SHALL serve RFC 8414 authorization server metadata for the issuer `<public base URL>/api/exomem/oauth`. A protected request MUST carry its access token in the `Authorization` header; a token in a URL, cookie, MCP argument or session field grants no authority.

#### Scenario: Unauthenticated client discovers authorization

- **WHEN** a client calls the MCP resource without a valid access token
- **THEN** it receives an HTTP `401` whose `WWW-Authenticate: Bearer` challenge names the resource's metadata document and the scopes to request
- **AND** the metadata identifies the Exomem authorization server and the exact resource without revealing account or tenant state

#### Scenario: MCP session state carries no authority

- **WHEN** an authorized client initializes, lists tools, or reuses or replaces an `mcp-session-id`
- **THEN** the gateway relays the request to the cell that the token's principal owns
- **AND** the session identifier cannot change the tenant or the cell

#### Scenario: Bearer token is placed in a prohibited location

- **WHEN** a caller supplies a token in a query string, cookie, tool argument, or MCP session field instead of the Authorization header
- **THEN** that value grants no authority, and the gateway authenticates to the cell only with its own derived cell bearer

### Requirement: OAuth Authorization Is Client-Bound And Exomem-Owned

The authorization server SHALL implement the authorization code grant with PKCE S256, exact redirect URI binding apart from the RFC 8252 loopback port rule, short-lived single-use codes, CSRF-safe browser state, resource-indicator binding to an accepted Cloud MCP resource, and explicit read and write scopes. A Cloud grant SHALL carry both `exomem.read` and `exomem.write`: a request that omits the scope receives both, and a request for only one is refused with `invalid_scope`. Clients SHALL be admitted only through an operator registration, a validated Client ID Metadata Document, or dynamic registration, which SHALL be refused unless the operator enables the generic client lane. Client resolution, authorization, consent, owner attachment, invite admission, code exchange, access lookup and refresh SHALL all apply one admission rule. The server MUST NOT accept or pass through another provider's access token as an Exomem credential.

#### Scenario: Approved public client authorizes correctly

- **WHEN** an approved client presents an exact registered redirect, an accepted resource, both scopes or no scope, a state value and an S256 PKCE challenge
- **THEN** the server begins one short-lived Exomem authorization transaction bound to those values

#### Scenario: Authorization code is intercepted or replayed

- **WHEN** a code is exchanged with a wrong client, redirect, resource, verifier, after expiry, or after prior use
- **THEN** token issuance fails without revealing identity, invite, tenant, or grant state

#### Scenario: Client metadata is unsafe or unapproved

- **WHEN** metadata resolution targets a private/non-HTTPS address, exceeds fetch bounds, redirects outside policy, mismatches its URL client ID, declares an unapproved redirect, or uses a disabled registration mechanism
- **THEN** authorization fails before user, entitlement, tenant, token, or infrastructure state is created

#### Scenario: Upstream identity service is unavailable after authorization

- **WHEN** an already-authorized client refreshes or calls MCP while the email or upstream login provider is unavailable
- **THEN** Exomem-owned token and policy state remains authoritative
- **AND** no new upstream provider token is minted for that client request

### Requirement: Login Reuses Invite And Magic-Link Identity Without Setup

An OAuth authorization transaction SHALL resume through the email-bound invite redemption or the non-enumerating sign-in link, and SHALL derive identity and tenant only from server state. A first authorization with a complimentary invite MUST run as one transaction under the Cloud capacity lock: check free Cloud capacity, consume the invite, resolve or create the identity, tenant, entitlement and one Cloud cell row, create the browser session recorded as `redeemed_session_id`, create the client grant and issue a one-time code. A paid invite SHALL be admitted with the same tenant, cell row and session but without a grant or code, and the consent page SHALL continue at checkout. An owner who already has a connectable tenant SHALL attach the new client grant to that tenant.

#### Scenario: New invitee authorizes from an app

- **WHEN** an invite-bound user completes the invite step during a client authorization with a complimentary invite and Cloud capacity is free
- **THEN** the transaction creates or resolves exactly one identity, browser session, tenant, entitlement, running cell row, client grant, and one-time authorization code
- **AND** the user reaches the app without another setup page

#### Scenario: New invitee holds a paid invite

- **WHEN** the invite-bound user completes the invite step with a paid invite
- **THEN** the transaction creates the tenant, an entitlement awaiting checkout, a stopped cell row and the browser session without a grant or code
- **AND** the consent page continues at checkout

#### Scenario: Existing entitled owner authorizes another client

- **WHEN** an identity that already owns a connectable Exomem tenant authorizes another admitted client
- **THEN** the new client grant binds to the existing tenant
- **AND** no invite, tenant, entitlement, or cell row is created or consumed

#### Scenario: User is not eligible

- **WHEN** the signed-in identity has no unspent invite and no connectable tenant
- **THEN** authorization does not complete
- **AND** no tenant, entitlement, OAuth grant, or cell row is created

#### Scenario: Invite is expired or replayed

- **WHEN** an expired, revoked, malformed, email-mismatched, or consumed invite is presented during OAuth authorization
- **THEN** admission refuses it with the same privacy-preserving answer as every other invalid invite
- **AND** the OAuth transaction cannot override the invite email or select a tenant

#### Scenario: Capacity is exhausted

- **WHEN** a first eligible authorization finds no free Cloud capacity
- **THEN** authorization returns the retryable `HOSTED_ADMISSION_CLOSED` outcome
- **AND** the invite remains usable and no tenant, entitlement, client grant, or cell row is created

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

### Requirement: Revocation Suspension And Deletion Fail Closed

Token use and refresh SHALL enforce the current grant, token family, account block and tenant state. Revoking a family SHALL end its access and refresh tokens. Revoking an account SHALL block it and end all its families. Deleting a tenant's cell SHALL revoke the tenant's grants, families and access tokens in the same transaction. A stopped cell SHALL refuse calls, and no request SHALL fall back to another tenant.

#### Scenario: Client authorization is revoked

- **WHEN** the owner disconnects an app, the client revokes its own token, or an operator revokes the family
- **THEN** its current access token and every refresh descendant fail on subsequent use
- **AND** no call reaches the cell

#### Scenario: Tenant is suspended

- **WHEN** a manual suspension or a revoked complimentary entitlement denies the tenant
- **THEN** its cell's desired state becomes `stopped` and the gateway answers `503` `CELL_NOT_READY` without contacting any cell

#### Scenario: Tenant is deleted

- **WHEN** the tenant enters deletion or its cell row is deleted
- **THEN** token use and refresh fail for that tenant
- **AND** no previous, default, or neighboring tenant is selected

### Requirement: OAuth And Gateway Telemetry Is Content-Free

OAuth and gateway logs SHALL carry only opaque identifiers, stage names, digests, timings, counts and stable codes. They MUST NOT carry OAuth secrets, codes or tokens, invite values, PKCE verifiers, raw redirect URIs, MCP arguments, memory content, cell credentials or provider credentials.

#### Scenario: Sensitive sentinel reaches an OAuth failure path

- **WHEN** authorization input or a resolver error contains a sensitive sentinel value
- **THEN** the response and the logged event carry only stable codes, stage names and digests
- **AND** the sentinel appears in neither

### Requirement: The owner is emailed when Substrate ends an app's sign-in

When the last live token family under an owner's grant ends without the
owner's action and the grant was used within the last 14 days, the system
SHALL email the owner once, naming the app by its Home display name, the day
access ended and how to reconnect. Detection SHALL run in the scheduled
OAuth sweep; each ended family SHALL notify at most once and at most one
email SHALL send per grant per 24 h.

#### Scenario: An idle lapse ends the family, not its row's expiry

- **WHEN** a family's last unconsumed refresh token expires while its row
  stays unrevoked and unexpired
- **THEN** the family is no longer live and its ending is eligible for notice

#### Scenario: A family without refresh produces no notice

- **WHEN** a family issued without refresh tokens loses its last unrevoked
  access token, or is itself revoked
- **THEN** it is not an ending for notice purposes and no email is enqueued —
  its liveness on Home still follows its access tokens

#### Scenario: A system revocation signs the app out

- **WHEN** a recently used grant's last live family is revoked by an
  operator, or carries the retired `refresh_replayed` reason
- **THEN** the sweep enqueues exactly one email to the owner naming the app
  and the day it signed out

#### Scenario: Repeated sweeps stay idempotent

- **WHEN** the same ended family is seen by a second sweep or a concurrent one
- **THEN** no further marker or email is produced for it

#### Scenario: Owner disconnect sends nothing

- **WHEN** the owner disconnects the app, or its account, cell or lifecycle
  takes the grant with it
- **THEN** no sign-out email is enqueued for that grant

#### Scenario: Quiet app sends nothing

- **WHEN** a grant's last family ends but its last recorded use is older than
  14 days
- **THEN** no email is enqueued for it

#### Scenario: A queued email is re-checked before it sends

- **WHEN** the owner disconnected or the app reconnected after the email was
  enqueued, or the account is gone
- **THEN** the email is cancelled without sending

#### Scenario: A name the app gave itself is marked as its own claim

- **WHEN** the app's display name came from its own client metadata
- **THEN** the email marks the name as the app's own claim, as Home does
