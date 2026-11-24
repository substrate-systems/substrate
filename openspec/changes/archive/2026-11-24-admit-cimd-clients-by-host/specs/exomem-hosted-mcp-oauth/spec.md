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

A client admitted by Client ID Metadata Document SHALL be eligible on the strength of the host that serves its document. The allowlist of admitted hosts, keyed by host and platform, SHALL be server state that the shared admission rule reads itself, so that every admission decision evaluates one identical predicate. Admission SHALL also require an enabled client row and validated, unexpired metadata whose time to live lies between five minutes and seven days. Admission SHALL read no client artifact, certification or cohort state. Pinned registrations SHALL remain eligible without metadata or host checks.

#### Scenario: A previously unseen connector on an admitted host authorizes

- **WHEN** a client that was never registered identifies by a valid metadata document served from an allowlisted host
- **THEN** the authorization endpoint registers it, and authorization proceeds in the same request

#### Scenario: Two distinct connectors from the same admitted host both authorize

- **WHEN** two clients present different metadata document URLs from the same allowlisted host
- **THEN** both are registered and admitted independently, each in its own client slot
- **AND** neither displaces, disables, or rewrites the other's registration

#### Scenario: Cached client metadata has expired

- **WHEN** an allowlisted-host client authorizes after its stored metadata time to live has elapsed
- **THEN** admission refuses the stored row, and the authorization endpoint re-fetches and revalidates the document before it admits the client
- **AND** an invalid or unreachable document leaves the client refused

#### Scenario: No certified artifact exists for the platform

- **WHEN** an allowlisted-host client authorizes
- **THEN** admission depends only on the client row, its metadata and its host, and reads no artifact, certification or cohort
- **AND** forwarding a call still requires the tenant's cell to be running or read-only

#### Scenario: Host authority is withdrawn before first-invite commit

- **WHEN** an authorization continuation was resolved while its host was allowlisted, and the host leaves the allowlist before the first-invite transaction commits, while the generic client lane is disabled
- **THEN** the transaction rechecks the client and its host under a key-share lock and refuses admission
- **AND** it does not consume the invite or create a tenant, entitlement, grant or cell row

### Requirement: First Authorization Registers An Allowlisted CIMD Client

The authorization endpoint SHALL register an unknown CIMD client on its first authorization attempt when the presented `client_id` is an HTTPS URL without credentials or a fragment whose host is on the admitted-host allowlist. The endpoint SHALL look the host up before any metadata fetch and, while the generic client lane is disabled, SHALL refuse an unlisted host without a fetch. Registration SHALL fetch and validate the document through the same path as operator registration, and SHALL store the client with its document digest, fetch time, time to live, host and platform. Registration SHALL rewrite only client rows that this path created.

Because this is an unauthenticated write path, it SHALL be rate limited per client address, it MUST NOT create, modify, or disclose user, tenant, entitlement, invite, or grant state, and every refusal SHALL be indistinguishable from an unknown client.

#### Scenario: Unknown connector on an admitted host authorizes for the first time

- **WHEN** an unrecognized `client_id` is an HTTPS URL on an allowlisted host and its metadata document validates
- **THEN** exactly one client row is created with CIMD admission, the allowlist's platform, and the document's digest, fetch time and time to live
- **AND** the authorization request continues without a second round trip from the client

#### Scenario: Registration is attempted repeatedly from one address

- **WHEN** registration attempts from a single client address exceed the auto-registration rate limit
- **THEN** further attempts are refused without registering a client or revealing which hosts are admitted

#### Scenario: Metadata fetch targets an unsafe address

- **WHEN** an allowlisted host's name resolves to a private or loopback address, or the fetch exceeds its time, header or body bounds
- **THEN** registration fails before any client row is created

#### Scenario: A registered client's document later changes

- **WHEN** a registered client's metadata time to live lapses and its host now serves a changed document
- **THEN** the next authorization, or the next refresh of a live refresh token, re-fetches and revalidates the document and replaces the stored digest, redirects and time to live
- **AND** admission fails closed if the new document is invalid

### Requirement: A Native CIMD Client May Redirect To Loopback

A self-registering CIMD client's metadata document SHALL be admitted only when it lists at least one redirect and every redirect is either HTTPS on the host that served the document or an `http` loopback redirect (`localhost`, `127.0.0.1` or `[::1]`) without credentials or a fragment. Any other redirect SHALL refuse registration and write no row.

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

The bound on stored OAuth clients SHALL be partitioned so that clients created by unauthenticated first-authorization registration are counted separately from operator-managed clients. A retired client SHALL hold no slot, and re-registering a live client SHALL need no new slot. Exhausting the auto-registration partition MUST NOT prevent an operator from registering or updating a client, and MUST NOT disable, evict, or rewrite any existing operator-managed client.

#### Scenario: Auto-registration partition is full

- **WHEN** the number of allowlisted auto-registered CIMD clients reaches its bound and a new unknown client authorizes on such a host
- **THEN** registration is refused, and the response is indistinguishable from an unknown client
- **AND** operator client registration and every already-admitted client continue to work

#### Scenario: Operator registers a client while auto-registrations exist

- **WHEN** an operator registers or updates a client while auto-registered clients are stored
- **THEN** the operation succeeds on its own partition's bound, independent of how many auto-registered clients exist
