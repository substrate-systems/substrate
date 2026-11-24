## MODIFIED Requirements

### Requirement: OAuth Authorization Is Client-Bound And Exomem-Owned

The authorization server SHALL implement the authorization code grant with PKCE S256, exact redirect URI binding apart from the RFC 8252 loopback port rule, short-lived single-use codes, CSRF-safe browser state, resource-indicator binding to an accepted Cloud MCP resource, and explicit read and write scopes. A Cloud grant SHALL carry both `exomem.read` and `exomem.write`: a request that omits the scope receives both, and a request for only one is refused with `invalid_scope`. Clients SHALL be admitted only through an operator registration or a validated Client ID Metadata Document from an operator-allowlisted host. While the operator enables the generic client lane, the server SHALL also admit dynamic registration and a validated Client ID Metadata Document from any HTTPS host; otherwise it SHALL refuse both. Admission SHALL confer no authority over a tenant: an admitted client reaches one only where an unspent invite or an existing ownership entitles the signed-in identity. Client resolution, authorization, consent, owner attachment, invite admission, code exchange, access lookup and refresh SHALL all apply one admission rule, so that no stage admits a client that another stage refuses. The server MUST NOT accept or pass through another provider's access token as an Exomem credential.

#### Scenario: Approved public client authorizes correctly

- **WHEN** an approved client presents an exact registered redirect, an accepted resource, both scopes or no scope, a state value and an S256 PKCE challenge
- **THEN** the server begins one short-lived Exomem authorization transaction bound to those values

#### Scenario: Authorization code is intercepted or replayed

- **WHEN** a code is exchanged with a wrong client, redirect, resource, verifier, after expiry, or after prior use
- **THEN** token issuance fails without revealing identity, invite, tenant, or grant state

#### Scenario: Client metadata is unsafe or unapproved

- **WHEN** metadata resolution targets a private/non-HTTPS address, exceeds fetch bounds, redirects outside policy, mismatches its URL client ID, declares an unapproved redirect, or uses a disabled registration mechanism
- **THEN** authorization fails before user, entitlement, tenant, token, or infrastructure state is created

#### Scenario: Client is served by a host outside the allowlist

- **WHEN** an unknown client presents an HTTPS Client ID Metadata Document URL whose host is not on the operator allowlist, while the generic client lane is disabled
- **THEN** authorization fails without registering a client, fetching that host's metadata, or disclosing whether any other client is admitted

#### Scenario: Upstream identity service is unavailable after authorization

- **WHEN** an already-authorized client refreshes or calls MCP while the email or upstream login provider is unavailable
- **THEN** Exomem-owned token and policy state remains authoritative
- **AND** no new upstream provider token is minted for that client request

## ADDED Requirements

### Requirement: CIMD Clients Are Admitted By Trusted Host Rather Than Pinned Digest

A client admitted by Client ID Metadata Document SHALL be eligible on the strength of the host that serves its document, independent of any promoted artifact's `oauth_client_config_sha256` or live platform artifact cohort. The allowlist of admitted hosts SHALL be authoritative server state readable by the admission queries themselves, so that every admission decision in the system evaluates one identical predicate. Admission SHALL additionally require enabled client state and unexpired validated metadata. Ordinary authorization SHALL enforce current owner, consent, entitlement and token policy; new provisioning SHALL atomically select an eligible live runtime target. Transient cell readiness MUST NOT invalidate otherwise valid ordinary authorization or refresh; tool execution SHALL separately require a ready compatible bound cell.

Approved pinned registrations SHALL remain eligible without a certified artifact. Independently governed provider-review bootstrap authority SHALL retain its separate purpose and limits.

#### Scenario: A previously unseen connector on an admitted host authorizes

- **WHEN** a client whose configuration digest matches no promoted artifact identifies by a valid metadata document served from a currently admitted host and satisfies ordinary service policy
- **THEN** the client is admitted and authorization proceeds normally

#### Scenario: Two distinct connectors from the same admitted host both authorize

- **WHEN** two clients present different metadata documents, and therefore different configuration digests, from the same admitted host
- **THEN** both are admitted independently
- **AND** neither displaces, disables, or rewrites the other's registration

#### Scenario: Cached client metadata has expired

- **WHEN** an admitted-host client authorizes after its stored metadata TTL has elapsed
- **THEN** admission fails closed until the document is re-fetched and revalidated

#### Scenario: No certified artifact exists for the platform

- **WHEN** an admitted-host client authorizes while no certified artifact exists for its platform
- **THEN** artifact absence alone does not deny ordinary service authorization
- **AND** provisioning and tool execution still enforce their separate live-runtime and cell-readiness requirements

#### Scenario: Host authority is withdrawn before first-invite commit

- **WHEN** a CIMD continuation is resolved while its host is admitted but that authority is withdrawn before atomic first-invite admission
- **THEN** the transaction rechecks current client and host authority and refuses admission
- **AND** it does not consume the invite or create tenant, grant, capacity or provisioning state

### Requirement: First Authorization Registers An Allowlisted CIMD Client

The authorization endpoint SHALL register an unknown CIMD client on its first authorization attempt when, and only when, the presented `client_id` is an HTTPS URL whose host is on the admitted-host allowlist. Registration SHALL validate the metadata document through the same fetch path used by operator-managed registration, including its protections against private and non-HTTPS network addresses, and SHALL store the client with its document digest, fetch time, and TTL.

Because this is an unauthenticated write path, it SHALL be rate limited per client address, and it MUST NOT create, modify, or disclose user, tenant, entitlement, invite, or grant state.

#### Scenario: Unknown connector on an admitted host authorizes for the first time

- **WHEN** an unrecognized `client_id` is an HTTPS URL on an admitted host and its metadata document validates
- **THEN** exactly one client row is created with CIMD admission and the document's digest, fetch time and TTL
- **AND** the authorization transaction continues without a second round trip from the client

#### Scenario: Registration is attempted repeatedly from one address

- **WHEN** registration attempts from a single client address exceed the configured rate
- **THEN** further attempts are refused without registering a client or revealing which hosts are admitted

#### Scenario: Metadata fetch targets an unsafe address

- **WHEN** an allowlisted-host document resolves to a private, loopback, or non-HTTPS network address
- **THEN** registration fails before any client row is created

#### Scenario: A registered client's document later changes

- **WHEN** a client that is already registered presents a metadata document that no longer matches its stored digest
- **THEN** the stored registration is revalidated rather than silently trusted
- **AND** admission fails closed if the new document is invalid

### Requirement: A Native CIMD Client May Redirect To Loopback

A self-registering CIMD client's metadata document SHALL be admitted only when every redirect it lists is either HTTPS on the host that served the document or an `http` loopback redirect (`localhost`, `127.0.0.1` or `[::1]`) without credentials or a fragment. Any other redirect SHALL refuse registration and write no row.

Redirect binding at authorization SHALL stay exact, with one exception required by RFC 8252 §7.3: a loopback redirect registered without a port SHALL match a requested redirect with the same scheme, host, path and query on any port. A loopback redirect registered with a port SHALL still match only that port, and `localhost`, `127.0.0.1` and `[::1]` SHALL remain distinct hosts. Every authorization request SHALL still carry a PKCE S256 challenge.

#### Scenario: Claude Code registers from its metadata document

- **WHEN** an admitted host serves a document listing `http://localhost/callback` and `http://127.0.0.1/callback`
- **THEN** the client registers, and an authorization request redirecting to `http://localhost:<any port>/callback` passes redirect validation

#### Scenario: A document lists a cleartext non-loopback redirect

- **WHEN** a document lists an `http` redirect to any host other than a loopback address, alone or beside loopback redirects
- **THEN** registration fails and no client row is created

#### Scenario: A loopback redirect differs in more than its port

- **WHEN** a requested loopback redirect differs from every registered loopback redirect in host, path or query, or uses https
- **THEN** redirect validation refuses it

#### Scenario: A pinned loopback redirect keeps its port

- **WHEN** a client registered `http://127.0.0.1:47831/callback` and a request names another port
- **THEN** redirect validation refuses it

### Requirement: Auto-Registered Clients Cannot Exhaust Operator Client Capacity

The bound on stored OAuth clients SHALL be partitioned so that clients created by unauthenticated first-authorization registration are counted separately from operator-managed clients. Exhausting the auto-registration partition MUST NOT prevent an operator from registering or updating a client, and MUST NOT disable, evict, or rewrite any existing operator-managed client.

#### Scenario: Auto-registration partition is full

- **WHEN** the number of auto-registered CIMD clients reaches its bound and a new unknown client authorizes
- **THEN** registration is refused
- **AND** operator client registration and every already-admitted client continue to work

#### Scenario: Operator registers a client while auto-registrations exist

- **WHEN** an operator registers or updates a client while auto-registered clients are stored
- **THEN** the operation succeeds on its own partition's bound, independent of how many auto-registered clients exist
