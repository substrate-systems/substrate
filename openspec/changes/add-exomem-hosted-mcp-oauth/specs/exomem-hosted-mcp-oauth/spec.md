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

An OAuth authorization transaction SHALL resume through the existing email-bound invite redemption or non-enumerating magic-link authentication flow and SHALL derive identity and tenant exclusively from authoritative server state. A valid first authorization MUST atomically validate eligibility, reserve capacity, consume the invite when applicable, resolve or create one identity/tenant/entitlement/initial-provision operation, create the normal browser session recorded as `redeemed_session_id`, authorize the client grant, and issue one-time code without requiring Home setup, billing details for complimentary access, a tenant selector, or a second Exomem configuration step.

#### Scenario: New invitee authorizes from the plugin

- **WHEN** the invite-bound user completes one valid Exomem login during a client authorization transaction and capacity is available
- **THEN** the transaction creates or resolves exactly one identity, browser session, tenant, entitlement, capacity reservation, logical initial-provision operation, client grant, and one-time authorization code
- **AND** provider provisioning continues asynchronously without another setup page

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

The MCP resource SHALL serve `initialize` and `tools/list` from exactly one server-selected registered Exomem agent contract containing `hosted-alpha-agent-v1`, its ordered command-surface fingerprint, full schema-contract digest, protocol compatibility, and canonical tool descriptions, input schemas, and annotations. The selection SHALL be the current `live` cohort for ordinary tenants or the exact `pending` cohort durably assigned to an authenticated canary tenant. Substrate MAY add only its gateway-owned OAuth `securitySchemes` overlay and runtime `_meta['mcp/www_authenticate']`; it MUST NOT rewrite the imported tool schemas. Discovery MUST NOT contact, wake, health-check, or derive authority from a tenant cell and MUST NOT expose a full private control-plane command or a Substrate-maintained copy of profile membership.

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

### Requirement: Private Gateway Contracts Are A Versioned Candidate Catalog

Substrate SHALL retain an immutable generated full private-gateway contract fixture and semantic digest for every live or pending agent candidate release that may be routed. Before same-release enforcement is enabled, the current live 0.34.0 agent candidate SHALL receive an exact reviewed 0.34.0 full-gateway fixture from the same Exomem source commit; the historical 0.24.0 fixture SHALL be non-routable. The full gateway contract is distinct from the alpha agent profile. Each candidate and rollout assignment SHALL name exactly one fixture from the same source release and hosted protocol, and command validation SHALL select it only from the authenticated tenant's live or assigned candidate. A process-global singleton fixture, release-only fallback, mutable catalog row, ambiguous match, historical-only entry, or cross-release pairing MUST fail closed before a private request.

#### Scenario: Existing split live unit is repaired before enforcement

- **WHEN** the current live agent candidate is 0.34.0 but the only existing full fixture is historical 0.24.0
- **THEN** deployment generates and reviews the exact 0.34.0 full fixture before enabling catalog enforcement
- **AND** the 0.24.0 fixture cannot route the 0.34.0 live candidate

#### Scenario: Live and rollout cells coexist

- **WHEN** one tenant remains on coherent live release 0.34.0 while another has an active assignment to coherent pending release 0.35.0
- **THEN** each route validates commands and the fetched private contract against its candidate's exact versioned gateway fixture
- **AND** neither tenant is checked against the other release or a hard-coded historical fixture

#### Scenario: Candidate has no exact gateway fixture

- **WHEN** an agent candidate lacks one same-release gateway catalog entry or its semantic/byte digest differs
- **THEN** import, assignment, lifecycle execution, discovery-to-call transition, and promotion fail closed
- **AND** routing does not derive or fetch an unreviewed replacement at runtime

### Requirement: Candidate Canary Selection Is Durable And Server-Authoritative

The control plane SHALL allow only an authenticated operator to create a bounded `preparing` rollout assignment between one exact pending agent candidate and any exact existing tenant under the shared Hosted cohort lock. Each assignment SHALL contain an immutable monotonically increasing tenant generation, candidate ID, source release, protocol version, command fingerprint, agent schema digest, compatibility digest, full private-gateway contract digest, state, expiry, and compare-and-swap version, and SHALL NOT be retargeted in place. The assignment MAY become `active` only after the tenant's replacement cell reports the same complete identity through authenticated provisioner health. MCP SHALL resolve an active assignment only after bearer authentication from the access token's authoritative tenant. Pending OAuth and promotion-evidence authority SHALL additionally require an immutable reviewer-purpose tenant; an ordinary tenant's rollout assignment grants neither. Public OAuth or MCP input MUST NOT create, select, alter, or bypass an assignment. Removal, expiry, failure, retirement, activation, and promotion SHALL be serialized under the same lock and expose only content-free operator status.

#### Scenario: Assigned tenant proves a pending contract

- **WHEN** an operator assigns one canary tenant to a pending candidate and the tenant's private cell reports the exact candidate release, protocol, fingerprint, schema digest, and compatibility digest
- **THEN** that tenant's initialize, tools/list, and tool calls use the pending contract and matching private route
- **AND** every unassigned tenant continues to use the prior live cohort

#### Scenario: Ordinary tenant joins the fleet rollout

- **WHEN** an operator assigns an existing non-reviewer tenant to the pending candidate and its replacement cell proves the exact identity
- **THEN** activation revokes the tenant's prior live-client lineage and places it in an explicit fail-closed maintenance window while the full routable fleet converges
- **AND** the assignment cannot admit a pending OAuth client, create reviewer credentials, sign promotion evidence, or claim user-visible availability before global promotion and fresh live-client authorization

#### Scenario: Assignment exists while replacement cell is unready

- **WHEN** an operator has created a preparing assignment but the replacement cell has not proved the assignment's exact identity
- **THEN** the old live route remains authoritative and the assignment cannot authorize pending discovery, calls, or tokens
- **AND** no global release setting changes and no unassigned or unrelated lifecycle operation selects the pending release

#### Scenario: Candidate selector is supplied publicly

- **WHEN** a caller supplies a tenant, candidate, profile, release, artifact, or cell selector in an OAuth parameter, header, URL, MCP body, tool argument, cookie, or session field
- **THEN** the selector grants no authority and the request is rejected where reserved-selector policy requires
- **AND** no assignment, grant, routing target, or evidence identity changes

#### Scenario: Pending client resolves to an unassigned owner

- **WHEN** a pending candidate client begins authorization but the authenticated owner resolves to no active assignment for that candidate
- **THEN** authorization fails content-free before a code, grant, token family, tenant mutation, cell request, or provider effect is created

#### Scenario: Assignment expires before cell rollback

- **WHEN** a canary assignment expires or is removed while the tenant's cell still reports the pending contract instead of live
- **THEN** its candidate-bound grants, codes, token families, access tokens, and refresh descendants are revoked atomically and discovery and calls fail closed for that tenant
- **AND** neither OAuth nor MCP falls back to a mismatched live contract or another cell

#### Scenario: Candidate becomes the live cohort

- **WHEN** paired clean-client evidence is fresh, every routable cell reports the candidate, and the existing cohort promotion compare-and-swap succeeds
- **THEN** the candidate and its paired artifacts become live atomically and obsolete assignments retire in the same locked transition
- **AND** token descendants bound to that candidate remain valid through promotion while no tenant observes a mixed contract/client/cell identity

#### Scenario: Ordinary tenant exits rollout maintenance

- **WHEN** the assigned candidate becomes globally live
- **THEN** the ordinary tenant exits rollout maintenance only after a fresh authorization against the now-live client creates matching lineage
- **AND** previously revoked live-client tokens are not resurrected

### Requirement: Staged Client Releases Are Pre-Evidence And Non-Promotable

For each supported platform, an authenticated operator MAY create an immutable, bounded staged client-release declaration that binds one pending candidate to its exact package digest, archive digest, compatibility digest, schema digest, plugin version, OAuth client configuration digest, and registered-app identity where applicable. The declaration SHALL include operator provenance but no acceptance result, SHALL NOT be a client artifact, SHALL NOT become live, and SHALL NOT satisfy any promotion precondition. Candidate OAuth registration and enablement MAY use only an exact non-expired declaration. A later signed pending client artifact MUST match the declaration byte-for-byte and still provide fresh content-bearing evidence. Importing that exact artifact SHALL atomically mark the declaration `evidenced`; declaration expiry, removal, failure, or retirement before this transition SHALL revoke every code and token descendant that relied on it, while an evidenced declaration remains auditable authority for its exact matching artifact and cannot be replaced by another declaration.

#### Scenario: Candidate client authorizes before evidence exists

- **WHEN** the operator has staged an exact client release, activated a reviewer-purpose tenant assignment, and minted an exact short-lived internal-canary credential but no signed client artifact exists yet
- **THEN** that exact candidate client may complete authorization for the assigned reviewer tenant and run the clean-client proof
- **AND** the candidate remains unpromotable until fresh signed evidence creates the matching pending artifact

#### Scenario: Staged declaration differs from candidate locks

- **WHEN** a declaration's package, archive, compatibility, contract, version, OAuth configuration, platform, or registered-app identity differs from the candidate locks
- **THEN** declaration or client registration fails before authorization
- **AND** no assignment, OAuth client, token lineage, evidence artifact, or live cohort changes

#### Scenario: Evidence differs from the staged declaration

- **WHEN** a signed client result names bytes or client identity different from its staged declaration
- **THEN** artifact import fails and promotion remains impossible
- **AND** the declaration itself is never treated as evidence

#### Scenario: Declaration expires before evidence

- **WHEN** a staged declaration expires, is removed, fails, or retires before an exact signed artifact marks it evidenced
- **THEN** authorization completion, code exchange, access, and refresh fail and all descendant grants, codes, token families, access tokens, and refresh tokens are revoked atomically
- **AND** neither another declaration nor the live cohort is inherited

#### Scenario: Exact evidence supersedes staging authority

- **WHEN** a fresh signed pending artifact matches the declaration byte-for-byte
- **THEN** the declaration becomes evidenced atomically and existing exact lineage may continue to rely on that immutable declaration/artifact pair
- **AND** the evidence transition still does not promote the candidate by itself

### Requirement: Internal Canary Credentials Precede External Reviewer Credentials

An authenticated operator MAY mint a short-lived `internal_canary` reviewer credential only when it is bound to one exact reviewer-purpose tenant, active assignment generation, pending candidate, staged client declaration, and OAuth client. It SHALL be held only for the clean-client acceptance run, SHALL expire or revoke with any bound authority, and SHALL NOT be presented as a provider marketplace credential. Credentials intended for Anthropic or OpenAI reviewers SHALL remain unissued and undisclosed until the candidate and paired artifacts are live and the reviewer-access release gate passes.

#### Scenario: Clean-client run authenticates before promotion

- **WHEN** an operator begins the candidate proof with an exact active assignment and staged client declaration
- **THEN** issuing the internal-canary credential atomically seals and revokes the invite-created setup session/transaction graph, and the clean client uses that credential to create the fresh attributed reviewer-purpose session required by authorization completion
- **AND** its session, transaction, grants, codes, and tokens retain the same candidate, declaration, client, and assignment generation

#### Scenario: Provider reviewer credential is requested early

- **WHEN** an operator attempts to issue or disclose an Anthropic/OpenAI provider-review credential before promotion and reviewer-access readiness
- **THEN** issuance fails closed or the credential remains disabled and undisclosed
- **AND** internal canary authority does not imply provider reviewer access

### Requirement: Candidate OAuth Lineage Is Generation-Bound And Revocable

OAuth MAY resolve a pending candidate client before identity is known only while an exact non-expired staged client-release declaration, matching internal-canary credential, and reviewer-purpose preparing or active assignment exist for that candidate. Authorization completion MUST prove the authenticated owner resolves to the assignment's tenant and that the same generation is active before issuing a code or grant. The candidate ID, assignment generation, declaration ID, and OAuth client identity SHALL be copied durably through the authorization transaction, grant, authorization code, token family, access-token record, and every refresh descendant. Code exchange, access lookup, refresh, discovery, and calls SHALL accept candidate-bound lineage only while the exact generation remains active or the exact candidate is now live, the client belongs to that same candidate cohort, and the declaration is non-expired or evidenced by the exact matching pending/live artifact. Public client metadata, redirect state, cookies, headers, and parameters SHALL NOT supply or override lineage. Activating an assignment SHALL atomically revoke all existing tenant grants, codes, token families, access tokens, and refresh descendants whose client/candidate lineage differs, including ordinary live-client families.

#### Scenario: Assignment changes after authorization begins

- **WHEN** a pending client starts authorization under one assignment generation and that generation is removed, expires, fails, or is replaced before completion or code exchange
- **THEN** completion and exchange fail content-free and every descendant of that lineage is revoked or remains unissuable
- **AND** a newer assignment generation is not inherited implicitly

#### Scenario: Refresh is attempted after candidate retirement

- **WHEN** a refresh token is bound to a candidate generation that is no longer active and whose candidate did not become live
- **THEN** the family and its access descendants are revoked and refresh fails
- **AND** no token is rebound to the current live candidate

#### Scenario: Candidate is promoted between code issue and exchange

- **WHEN** a valid code names the exact candidate and assignment generation and that candidate becomes live before exchange
- **THEN** exchange and later refresh may continue against the now-live candidate
- **AND** promotion does not silently change the candidate identity recorded on the lineage

#### Scenario: Old live-client token is used after assignment activation

- **WHEN** a tenant's candidate assignment becomes active and an access or refresh token from the prior live client has no matching candidate generation
- **THEN** activation has revoked that family and discovery, calls, and refresh fail closed
- **AND** the old client artifact cannot drive the pending contract or cell

#### Scenario: Matching candidate token survives promotion

- **WHEN** a candidate-bound token names the promoted candidate and its assignment retires as part of promotion
- **THEN** access and refresh continue under the same now-live candidate identity
- **AND** no token is rebound to a different client or candidate

### Requirement: Lifecycle Operations Pin One Server-Selected Cell Release

Before the first provider or cell side effect, every provision and restore operation SHALL durably snapshot one target contract candidate, optional assignment generation, source release, protocol, command fingerprint, agent schema digest, compatibility digest, and full private-gateway contract digest. Any assigned fleet rollout SHALL snapshot that tenant's preparing assignment; unassigned provisioning and restore SHALL snapshot the current live cohort. The snapshot SHALL remain immutable across leases, waits, retries, restarts, and concurrent cohort changes, and execution SHALL use it instead of reading a process-wide release version. Existing global environment configuration MAY validate platform support but MUST NOT select a tenant's release.

#### Scenario: Cohort changes while an operation retries

- **WHEN** a provision or restore operation waits or retries after another candidate becomes live
- **THEN** every retry uses the operation's original complete target snapshot
- **AND** no provider request, candidate cell, or readiness check drifts to the newly live or globally configured release

#### Scenario: Canary cell is rolled

- **WHEN** an operator creates a preparing assignment and requests the tenant rollout
- **THEN** the control plane quiesces and exports the current cell, restores a replacement from the exact snapshotted candidate, requires authenticated provisioner health to report matching gateway digest plus agent release/protocol/fingerprint/schema/compatibility locks, and atomically rebinds the tenant before activating the assignment
- **AND** failure preserves the old binding when safe or fails the tenant closed without selecting another cell

#### Scenario: Provisioner health omits contract locks

- **WHEN** a replacement reports ready but health omits or mismatches the full gateway digest or any agent lock
- **THEN** the lifecycle operation cannot bind the cell or activate the assignment
- **AND** release text alone is insufficient readiness authority

#### Scenario: Ordinary tenant provisions during a canary

- **WHEN** an unassigned tenant begins provisioning or restore while another tenant has a pending canary assignment
- **THEN** its lifecycle operation snapshots the current live cohort
- **AND** it cannot select the pending release from a process environment change, another tenant's assignment, or a later promotion

### Requirement: Hosted Rollback Replays The Normal Forward Promotion Path

Rollback SHALL retain the prior immutable image, contract, and paired client artifacts and import them as a new pending candidate rather than reviving a retired row. Operators SHALL create fresh assignment generations, roll affected tenants back through the same quiesce/export/restore/rebind sequence, collect fresh paired clean-client evidence against the restored candidate, and promote it through the normal routable-set compare-and-swap. Evidence from the prior promotion MUST NOT be reused. Until each tenant is rolled, the current live cohort SHALL remain authoritative for that tenant; any cell/selection mismatch SHALL fail closed.

#### Scenario: Operator requests rollback after promotion

- **WHEN** the newly live cohort must be rolled back
- **THEN** the prior release is re-imported as a new pending candidate and tenants receive fresh generations and immutable restore targets
- **AND** demoting the current live row alone neither completes rollback nor makes the retired prior row live

#### Scenario: One tenant has rolled back and another has not

- **WHEN** rollback is staged across the cohort
- **THEN** the rolled tenant uses its active rollback assignment while the unrolled tenant continues to use the current live cohort
- **AND** both fail closed on any selected-contract/cell mismatch

#### Scenario: Rollback candidate reaches global promotion

- **WHEN** every routable tenant reports the rollback candidate and fresh paired evidence passes
- **THEN** the ordinary locked promotion retires the faulty live cohort and makes the rollback candidate live atomically
- **AND** obsolete assignments retire without reusing historical evidence or reviving retired records

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
