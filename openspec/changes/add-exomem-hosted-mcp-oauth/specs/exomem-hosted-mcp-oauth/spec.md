## ADDED Requirements

### Requirement: Public MCP Is A Standards-Compatible Protected Resource

The system SHALL expose one versioned production HTTPS Streamable HTTP MCP resource for Exomem Hosted and SHALL publish the OAuth Protected Resource Metadata, Authorization Server Metadata, challenges, protocol negotiation, and transport behavior required by the promoted Claude and OpenAI clients. Every protected MCP request MUST carry a bearer access token in the `Authorization` header; tokens in URLs, cookies, MCP arguments, or session identifiers MUST be rejected or ignored as authority.

#### Scenario: Unauthenticated client discovers authorization

- **WHEN** a supported client contacts the protected MCP resource without a valid access token
- **THEN** it receives an HTTP `401` challenge pointing to the canonical protected-resource metadata
- **AND** the metadata identifies the Exomem authorization server and exact resource without revealing account or tenant state

#### Scenario: Client negotiates Streamable HTTP

- **WHEN** an authorized promoted client initializes using a supported MCP protocol version
- **THEN** the server negotiates only its pinned compatible protocol range and returns the registered Exomem server capabilities
- **AND** losing or replacing an MCP session identifier cannot change tenant authority or provision infrastructure

#### Scenario: Bearer token is placed in a prohibited location

- **WHEN** a caller supplies a token in a query string, cookie, tool argument, or MCP session field instead of the Authorization header
- **THEN** that value grants no authority and is never forwarded to a cell

### Requirement: OAuth Authorization Is Client-Bound And Exomem-Owned

The authorization server SHALL implement authorization code with PKCE S256, exact redirect URI binding, short-lived single-use codes, CSRF-safe browser state, resource-indicator/audience binding, explicit read/write scopes, and the client registration mechanisms proven necessary by the promoted hosts. It MUST NOT accept or pass through another provider's access token as an Exomem credential, and generic arbitrary client admission MUST remain disabled during the friends alpha.

#### Scenario: Approved public client authorizes correctly

- **WHEN** a promoted client presents an approved pre-registration, validated HTTPS Client ID Metadata Document, or explicitly enabled bounded registration with an exact redirect, resource, scopes, state, and PKCE challenge
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

An OAuth authorization transaction SHALL derive identity and tenant exclusively from authoritative server state. In the alpha, the proven email-bound invite acceptance flow first atomically creates the normal browser session, tenant, entitlement, capacity reservation, and initial-provision operation; plugin OAuth then connects that existing eligible owner through the browser session or magic-link authentication flow. Pre-tenant OAuth invite resumption is deferred. OAuth never requires Home setup, billing details for complimentary access, a tenant selector, or a second Exomem configuration step.

#### Scenario: New invitee accepts an invite before plugin OAuth

- **WHEN** the invite-bound user completes the existing invite acceptance flow and capacity is available
- **THEN** that transaction creates or resolves exactly one identity, browser session, tenant, entitlement, capacity reservation, and logical initial-provision operation
- **AND** a later plugin OAuth authorization attaches a client grant to that existing owner while provider provisioning continues asynchronously

#### Scenario: Existing entitled owner authorizes another client

- **WHEN** an identity that already owns one eligible Exomem tenant authorizes a promoted second client
- **THEN** the new client grant binds to the existing tenant
- **AND** no invite, tenant, entitlement, capacity reservation, provisioning operation, cell, or volume is duplicated

#### Scenario: User is not eligible

- **WHEN** the authenticated email has no valid invite, paid entitlement, or existing eligible Exomem tenant
- **THEN** authorization fails with a non-enumerating request-access experience
- **AND** no tenant, entitlement, OAuth grant, provisioning operation, cell, or volume is created

#### Scenario: Invite is expired or replayed

- **WHEN** an expired, revoked, malformed, email-mismatched, or consumed invite is presented during OAuth authorization
- **THEN** admission fails with the existing stable privacy-preserving semantics
- **AND** the OAuth transaction cannot override the invite email or select a tenant

#### Scenario: Capacity is exhausted

- **WHEN** a first eligible authorization cannot atomically reserve the required alpha capacity
- **THEN** authorization returns a stable temporary-capacity outcome with an opaque request reference
- **AND** the invite remains usable and no tenant, entitlement, client grant, provisioning operation, cell, or volume is created

### Requirement: Token Families Provide Durable Revocable Continuity

The authorization server SHALL issue high-entropy opaque authorization codes, short-lived access tokens, and one-time rotating refresh tokens while storing only their digests. Every token MUST be bound to the Exomem issuer, exact MCP resource audience, client, identity, grant, scopes, and token family. Access checks SHALL enforce current grant, entitlement, tenant, and lifecycle state; refresh replay MUST revoke the affected family; raw credentials MUST NOT be logged or persisted.

#### Scenario: Client restarts after initial login

- **WHEN** a valid refresh token is used after the client or conversation restarts
- **THEN** the server atomically rotates it and returns a new short-lived access token plus replacement refresh token
- **AND** the user is not asked to log in again during the configured valid family lifetime

#### Scenario: Rotated refresh token is replayed

- **WHEN** an already-consumed refresh token is presented
- **THEN** the token family is revoked and neither the replay nor its descendants can mint another access token

#### Scenario: One client family is revoked

- **WHEN** the user or operator revokes one Claude or OpenAI client authorization
- **THEN** that family's access and refresh tokens fail centrally
- **AND** a separately authorized client family remains usable unless account-wide policy also denies it

#### Scenario: Access token has wrong audience or scope

- **WHEN** a valid-looking token was not issued for the exact Exomem MCP resource or lacks the canonical command's required read/write scope
- **THEN** the resource rejects it with the standards-appropriate `401` or `403` response before tenant or cell routing

### Requirement: Tool Discovery Is Static, Pinned, And Cell-Independent

The MCP resource SHALL serve `initialize` and `tools/list` from one registered `live` Exomem agent contract containing exactly `hosted-alpha-agent-v1`, its ordered command-surface fingerprint, full schema-contract digest, protocol compatibility, and canonical tool descriptions, input schemas, and annotations. Substrate MAY add only its gateway-owned OAuth `securitySchemes` overlay and runtime `_meta['mcp/www_authenticate']`; it MUST NOT rewrite the imported tool schemas. Discovery MUST NOT contact, wake, health-check, or derive authority from a tenant cell and MUST NOT expose a full private control-plane command or a Substrate-maintained copy of profile membership.

#### Scenario: Authorized tenant is still provisioning

- **WHEN** an authorized client initializes or lists tools before its cell is ready
- **THEN** it receives the complete pinned alpha tool surface with the registered fingerprint
- **AND** no provider or cell request is made

#### Scenario: Candidate contract differs from live

- **WHEN** a newly imported contract has a different profile, fingerprint, schema digest, or incompatible protocol from the registered live record
- **THEN** it remains pending and existing discovery remains atomically bound to the prior live record
- **AND** no mixed tool surface is served

#### Scenario: Full private command is requested through MCP

- **WHEN** a client names transfer, media, adoption, broad editing/replacement, maintenance, schema, coordination, Tier-2, or another command outside `hosted-alpha-agent-v1`
- **THEN** the MCP resource rejects it before entitlement evaluation or cell forwarding
- **AND** it does not fall back to the Home or full private command route

### Requirement: Tool Calls Resolve One Tenant And One Agent Route

For every MCP tool call, the gateway SHALL validate token, client, audience, scope, request bounds, current provider-neutral entitlement, authoritative identity-to-tenant-to-cell mapping, lifecycle/readiness state, and exact profile compatibility before forwarding only to the mapped cell's authenticated profile-specific private agent route. No public field MAY select or override tenant, cell, vault, private endpoint, principal, profile, or service credential, and the public bearer token MUST NOT be forwarded.

#### Scenario: Ready entitled owner calls an allowed tool

- **WHEN** a valid authorized owner invokes a command in the registered alpha profile and the exact mapped cell is ready and compatible
- **THEN** the gateway forwards the canonical command and arguments to that cell's profile-specific private route with Substrate-created trusted context
- **AND** canonical result, error, mutation, and idempotency behavior is preserved

#### Scenario: Caller supplies routing or profile selectors

- **WHEN** an MCP body, argument, query, cookie, session field, or untrusted header includes a tenant, cell, vault, endpoint, principal, or profile selector
- **THEN** it is rejected or stripped under the reserved-field contract and cannot affect routing

#### Scenario: Mapped cell is unavailable or mismatched

- **WHEN** the authoritative cell is unavailable, reports another identity, lacks the registered profile contract, or has an incompatible release/protocol/fingerprint
- **THEN** the call fails with a stable content-free error
- **AND** no other tenant, historical cell, default cell, full private route, or neighboring warm process is tried

#### Scenario: Automatic mutation retry occurs

- **WHEN** a mutation acknowledgement is lost and the gateway retries
- **THEN** it reuses the same tenant/principal/command/canonical-payload idempotency namespace
- **AND** it never retries an ambiguous mutation under a newly generated key

### Requirement: Provisioning State Is Connected But Never Fabricated

OAuth MAY complete after durable admission and before cell readiness. Authenticated initialization and discovery SHALL remain available, while a content-bearing call to a non-ready tenant MUST return a stable MCP tool error with lifecycle class, retryability, bounded retry timing when applicable, and an opaque request ID. The gateway MUST NOT fabricate an empty successful memory response, block indefinitely, disclose provider details, or route elsewhere.

#### Scenario: Provisioning is progressing normally

- **WHEN** an authorized client calls a memory tool while its initial operation is pending or running
- **THEN** the tool returns `TENANT_PREPARING` with safe retry timing and an opaque support reference
- **AND** no content result or alternate routing is produced

#### Scenario: Provisioning failed terminally

- **WHEN** the tenant's initial operation is terminally failed
- **THEN** calls return a stable non-retryable or operator-retryable provisioning failure according to the recorded class
- **AND** neither a new cell nor a new provisioning identity is created by the call

#### Scenario: Readiness appears under the expected identity

- **WHEN** private readiness proves exact cell identity, release, protocol, alpha profile, mutation authority, and zero-worker policy
- **THEN** subsequent eligible calls may route to that cell without reauthorization

### Requirement: Ingress And Entitlement Bound Alpha Cost

The initial MCP service SHALL allocate no tenant infrastructure for plugin installation, metadata/discovery, client registration, failed authentication, or ineligible authorization. First eligible provisioning SHALL use the alpha entitlement of 5 GiB usable storage, a 90 MiB upload ceiling, and zero optional workers, and SHALL be gated by durable storage/runtime/provision capacity. The public ingress MUST enforce bounded pre-auth and post-auth request size, response size, rate, concurrent-call, retry, and timeout policies without using content in keys or telemetry.

#### Scenario: Many users install without authorizing

- **WHEN** clients fetch package metadata, OAuth metadata, challenges, or registration/discovery material without completing eligible authorization
- **THEN** no tenant, cell, volume, worker, or provider provisioning call is created

#### Scenario: Discovery is polled repeatedly

- **WHEN** an authorized or reconnecting client repeatedly initializes or lists tools
- **THEN** responses come from the pinned shared contract under bounded rate policy
- **AND** no tenant process is woken and no provision call is amplified

#### Scenario: Request exceeds an ingress bound

- **WHEN** a caller exceeds byte, rate, concurrency, retry, or deadline policy
- **THEN** the gateway rejects or throttles it with a stable content-free response before unbounded buffering or cell work
- **AND** another tenant's budget or routing context is unaffected

#### Scenario: Excluded expensive capability is requested

- **WHEN** a client attempts transfer, media processing, adoption, maintenance, schema administration, Tier-2, or optional model-worker behavior
- **THEN** the operation is absent or rejected by the pinned profile before provider or cell work
- **AND** worker count remains zero for the alpha entitlement

### Requirement: Revocation Suspension And Deletion Fail Closed

Every MCP request and token refresh SHALL enforce current grant, entitlement, tenant, and lifecycle policy. Revocation MUST deny the targeted access/refresh family; suspension MUST deny calls and drive verified active-runtime stop while preserving durable data under retention policy; deletion MUST deny all grants and routing and MUST never fall back to another tenant.

#### Scenario: Client authorization is revoked

- **WHEN** a user or operator revokes a client family
- **THEN** its current access token and every refresh descendant fail on subsequent use
- **AND** no cell call is forwarded

#### Scenario: Tenant is suspended

- **WHEN** manual or entitlement policy suspends a tenant
- **THEN** all MCP calls are denied with a stable suspended result and lifecycle reconciliation stops or quiesces active compute
- **AND** the retained volume is neither exposed nor treated as free storage capacity

#### Scenario: Tenant is deleted

- **WHEN** Exomem deletion begins or completes
- **THEN** MCP authorization, refresh, discovery authority, and tool routing fail according to deletion state
- **AND** no previous, default, or neighboring tenant is selected

### Requirement: OAuth MCP And Capacity Telemetry Is Content-Free

Operational records and logs SHALL contain only opaque request, client, grant-family, tenant, operation, capacity-bucket, contract, transition, timing, byte-count, and stable-code metadata needed for reliability and cost analysis. They MUST NOT contain raw email where an opaque reference suffices, OAuth secrets/codes/tokens, invite values, MCP arguments, query text, titles, paths, excerpts, note content, private endpoints, cell credentials, Paddle identifiers, or provider credentials.

#### Scenario: Sensitive sentinel reaches every failure layer

- **WHEN** authorization input, an MCP command, or a downstream cell/provider error contains a sensitive sentinel
- **THEN** public responses and persisted/logged telemetry reduce it to allowlisted codes and opaque references
- **AND** the sentinel is absent from OAuth, gateway, lifecycle, capacity, and promotion records

#### Scenario: Cost dashboard aggregates usage

- **WHEN** operators inspect alpha cost and reliability
- **THEN** they can measure resource reservations, storage occupancy, active runtime, provision calls, MCP calls/bytes/retries, latency, errors, and client versions per opaque tenant/cohort
- **AND** no memory content is required for those measurements

### Requirement: Live Acceptance Proves The Complete Cross-Client Journey

Before friends distribution, one evidence-bound run shared with `add-hosted-client-plugins` SHALL prove on real clean Claude and OpenAI clients that a valid invitee installs one plugin, completes one uninterrupted Exomem login/authorization per installation, and uses governed long-term memory automatically from a fresh chat without configuration or Exomem-specific prompting. Success MUST include seeded content recall, citation, durable capture, later fresh-chat recall, same-tenant attachment by the other client, refresh/restart continuity, and measured cost/latency budgets.

#### Scenario: First client completes the product target

- **WHEN** a never-before-seen invited identity installs a pending package and authorizes from a clean supported client
- **THEN** evidence shows exactly one identity, tenant, entitlement, capacity reservation, provisioning operation, cell, and volume followed by a content-bearing recall, governed write, and fresh-chat recall
- **AND** the conversation contains no setup, bootstrap, `@Exomem`, or explicit save/use-memory prompt

#### Scenario: Other client attaches to the same memory

- **WHEN** the same Exomem identity separately authorizes the other promoted client
- **THEN** it reaches the same seeded and newly captured content through its own token family
- **AND** the infrastructure counts remain one tenant, one active cell, and one volume

#### Scenario: Connectivity-only smoke is attempted

- **WHEN** a run proves only OAuth, initialization, tool listing, bootstrap, metadata, or a content-free read
- **THEN** acceptance fails and neither the contract nor package is promoted on that evidence

#### Scenario: Adversarial lifecycle matrix runs

- **WHEN** tests inject duplicate callbacks, concurrent first login, expired/replayed invites, capacity exhaustion, delayed/terminal provisioning, stale discovery, cell mismatch, refresh replay, revocation, suspension, deletion, and concurrent two-tenant sentinels
- **THEN** exact counts, stable errors, retry behavior, no-fallback routing, and content isolation match the registered contracts
