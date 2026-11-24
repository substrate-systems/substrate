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

### Requirement: CIMD Clients Are Admitted By Trusted Host Rather Than Pinned Digest

A client admitted by Client ID Metadata Document SHALL be eligible on the strength of the host that serves its document. The allowlist of admitted hosts, keyed by host and platform, SHALL be server state that the shared admission rule reads itself, so that every admission decision evaluates one identical predicate. Admission SHALL also require an enabled client row and validated, unexpired metadata whose time to live lies between five minutes and seven days. Admission SHALL read no client artifact, certification or cohort state. Pinned registrations SHALL remain eligible without metadata or host checks.

While the generic client lane is enabled, the shared admission rule SHALL also admit a CIMD client whose host and platform are not on the allowlist. Such a lane-admitted client SHALL carry no platform and no platform configuration digest. Disabling the lane SHALL stop every lane-admitted client at every stage. An allowlisted CIMD client SHALL stay admitted while the lane is in either state.

#### Scenario: A previously unseen connector on an admitted host authorizes

- **WHEN** a client that was never registered identifies by a valid metadata document served from an allowlisted host
- **THEN** the authorization endpoint registers it, and authorization proceeds in the same request

#### Scenario: A connector on an unlisted host authorizes while the lane is enabled

- **WHEN** a client that was never registered identifies by a valid metadata document served from an HTTPS host outside the allowlist, while the generic client lane is enabled
- **THEN** the authorization endpoint registers it with no platform, the shared admission rule admits it through the lane, and authorization proceeds in the same request

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

#### Scenario: Lane is withdrawn after a lane-admitted client connected

- **WHEN** an operator disables the generic client lane while a lane-admitted CIMD client holds live grants
- **THEN** that client stops being admitted at authorization, consent, token exchange, refresh and the MCP lookup, without any per-client action
- **AND** allowlisted CIMD and pinned clients are unaffected

### Requirement: First Authorization Registers An Allowlisted CIMD Client

The authorization endpoint SHALL register an unknown CIMD client on its first authorization attempt when the presented `client_id` is an HTTPS URL without credentials or a fragment whose host is on the admitted-host allowlist. The endpoint SHALL look the host up before any metadata fetch and, while the generic client lane is disabled, SHALL refuse an unlisted host without a fetch. Registration SHALL fetch and validate the document through the same path as operator registration, and SHALL store the client with its document digest, fetch time, time to live, host and platform. Registration SHALL rewrite only client rows that this path created.

While the generic client lane is enabled, the endpoint SHALL also register a client whose host is not on the allowlist. That registration SHALL store the serving host, no platform and no platform configuration digest, and SHALL take its slot in the generic partition. The statement that writes the row SHALL recheck the lane, so that a lane disabled after the host lookup leaves no row.

Because this is an unauthenticated write path, it SHALL be rate limited per client address, it MUST NOT create, modify, or disclose user, tenant, entitlement, invite, or grant state, and every refusal SHALL be indistinguishable from an unknown client.

#### Scenario: Unknown connector on an admitted host authorizes for the first time

- **WHEN** an unrecognized `client_id` is an HTTPS URL on an allowlisted host and its metadata document validates
- **THEN** exactly one client row is created with CIMD admission, the allowlist's platform, and the document's digest, fetch time and time to live
- **AND** the authorization request continues without a second round trip from the client

#### Scenario: Unknown connector on an unlisted host authorizes while the lane is enabled

- **WHEN** an unrecognized `client_id` is an HTTPS URL on a host outside the allowlist, the generic client lane is enabled, and its metadata document validates
- **THEN** exactly one client row is created with CIMD admission, the serving host, no platform and no platform configuration digest
- **AND** the row takes a slot in the generic partition

#### Scenario: Unknown connector on an unlisted host authorizes while the lane is disabled

- **WHEN** an unrecognized `client_id` is an HTTPS URL on a host outside the allowlist and the generic client lane is disabled
- **THEN** no metadata fetch is attempted, no client row is created, and the response is indistinguishable from an unknown client

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

### Requirement: Generic MCP Clients Are Admitted Without Certification

A client that no marketplace distributes SHALL be admissible without a configuration digest or a platform. Such a client SHALL carry admission mode `generic` and no `client_platform`, or, as a lane-admitted CIMD client, admission mode `cimd` and no `client_platform`. Its admission SHALL read no artifact, certification or cohort state.

The generic arm SHALL be part of the shared admission rule that authorization, consent, owner attachment, invite admission, token exchange, bearer use, the MCP lookup and refresh apply, so that a client admitted at one stage is admitted at all of them. Marketplace reviewer credential redemption SHALL exclude the generic arm and the lane, and SHALL admit only pinned and allowlisted clients.

Pinned and host-allowlist admission SHALL be unchanged in behaviour. Apart from lane-admitted CIMD clients, the generic arm SHALL NOT admit a client of any other mode.

#### Scenario: A generic client authorizes and calls MCP

- **WHEN** an enabled generic client presents an exact redirect, resource, scopes, state and PKCE challenge, and the authenticated identity already owns a tenant
- **THEN** the client is admitted, a grant is issued, and the same client is admitted at token exchange, bearer use, the MCP lookup and refresh

#### Scenario: A generic client is refused without an invite

- **WHEN** a generic client authorizes for an identity that holds neither an unspent invite nor an existing tenant
- **THEN** no tenant, entitlement, grant or token is created, and the refusal does not disclose whether that identity is known

#### Scenario: Certified admission is unaffected

- **WHEN** a pinned or host-allowlist client authorizes while the generic lane is enabled
- **THEN** it is admitted on exactly the terms it was before
- **AND** withdrawing its host stops a host-allowlist client at every stage while the lane is disabled, and leaves it admitted through the lane while the lane is enabled

#### Scenario: A generic client is admitted where no platform cohort exists

- **WHEN** a generic client authorizes while no certified artifact exists for any platform
- **THEN** admission succeeds on the generic arm, which reads only the client's admission mode, its enabled flag and the lane state

#### Scenario: A lane-admitted CIMD client redeems no reviewer credential

- **WHEN** a client that only the generic lane admits begins a marketplace reviewer credential redemption
- **THEN** the redemption refuses it, because reviewer redemption admits only pinned and allowlisted clients

### Requirement: Generic Admission Is Disabled Until Deliberately Enabled

The generic lane SHALL be governed by authoritative server state that the admission predicates read directly, not by process configuration alone, so that one operator action enables or withdraws it everywhere atomically. It SHALL be disabled by default.

While disabled, the authorization server metadata document SHALL NOT advertise a `registration_endpoint`, the registration endpoint SHALL refuse every request indistinguishably from an unknown route, and no previously registered generic client SHALL be admitted at any stage. No CIMD client from a host outside the allowlist SHALL be registered or admitted either, and the server SHALL fetch no metadata for it.

#### Scenario: The lane is disabled

- **WHEN** any generic client authorizes, exchanges, refreshes or calls MCP while the lane is disabled
- **THEN** every stage refuses, and metadata advertises no registration endpoint

#### Scenario: An unlisted CIMD client arrives while the lane is disabled

- **WHEN** a client identifies by an HTTPS metadata document on a host outside the allowlist while the lane is disabled
- **THEN** authorization fails without fetching that host's document, registering a client, or disclosing the lane's state

#### Scenario: The lane is withdrawn after clients registered

- **WHEN** an operator disables the lane while generic or lane-admitted CIMD clients hold live grants
- **THEN** those clients stop being admitted at every stage without any per-client action
- **AND** pinned and allowlisted CIMD clients are unaffected

### Requirement: Auto-Registered Clients Cannot Exhaust Operator Client Capacity

The bound on stored OAuth clients SHALL be partitioned so that clients created by unauthenticated first-authorization registration are counted separately from operator-managed clients. A retired client SHALL hold no slot, and re-registering a live client SHALL need no new slot in its own partition. Lane-admitted CIMD clients SHALL count in the generic partition with dynamic registrations, apart from allowlisted CIMD clients. Exhausting the auto-registration or the generic partition MUST NOT prevent an operator from registering or updating a client, and MUST NOT disable, evict, or rewrite any existing operator-managed client.

#### Scenario: Auto-registration partition is full

- **WHEN** the number of allowlisted auto-registered CIMD clients reaches its bound and a new unknown client authorizes on such a host
- **THEN** registration is refused, and the response is indistinguishable from an unknown client
- **AND** operator client registration and every already-admitted client continue to work

#### Scenario: Generic partition is full of lane-admitted CIMD clients

- **WHEN** lane-admitted CIMD clients and dynamic registrations together reach the generic bound, and a new dynamic registration or an unknown client on a host outside the allowlist arrives
- **THEN** registration is refused
- **AND** allowlisted CIMD registration, operator registration and every already-admitted client continue to work

#### Scenario: Operator registers a client while auto-registrations exist

- **WHEN** an operator registers or updates a client while auto-registered clients are stored
- **THEN** the operation succeeds on its own partition's bound, independent of how many auto-registered clients exist

#### Scenario: Re-registration moves a client to another partition
- **WHEN** a live auto-registered client re-registers into a different partition, such as an allowlisted client whose host was delisted while the generic lane is enabled
- **THEN** the server SHALL admit it only when the target partition has a free slot

## ADDED Requirements

### Requirement: An OAuth Client Carries A Stored Context

Every OAuth client SHALL carry a `client_context` of `coding` or `conversation`, set at registration from redirect shape — all-loopback redirects mean `coding`, otherwise `conversation` — and read, not re-derived, by the gateway, transfer tools and Home. The grant's owner SHALL be able to override it for their own grant only, through an owner-authorized mutation answering malformed, unknown and foreign app identifiers indistinguishably; re-registration SHALL preserve the stored choice.

#### Scenario: Registration stores the derived context

- **WHEN** a client registers with only loopback redirects, or with any non-loopback redirect, under any admission mode
- **THEN** the stored row carries `coding` or `conversation` respectively

#### Scenario: The owner changes an app's context

- **WHEN** the owner of the grant's tenant sets a connected app's context through the authorized route
- **THEN** that grant's stored override changes, and the gateway's next lookup for that grant and the owner's Home app list reflect it

#### Scenario: Another owner's context is unaffected

- **WHEN** two owners hold grants to the same client and one changes the context
- **THEN** the other owner's app list and gateway lookups keep the registration-derived context

#### Scenario: A non-owner changes an app's context

- **WHEN** an authenticated identity that does not own the grant's tenant targets an app, or the app ID is malformed or unknown
- **THEN** the response is indistinguishable from an unknown app and no row changes

#### Scenario: Re-registration preserves the owner's choice

- **WHEN** a self-registering client whose context the owner changed re-registers or refreshes its registration
- **THEN** the stored context remains the owner's choice, not the derived default

### Requirement: A Client's Verified Host Is Shown Apart From Its Claimed Name

For a client admitted by Client ID Metadata Document, the consent page and app surfaces SHALL present the verified host that serves the client's document (`cimd_host`) as the vouching identity, and SHALL present the client's self-declared `client_name` only as the client's own claim. No surface SHALL imply that a self-declared name proves product identity. For a client with no metadata host, the self-declared name SHALL continue to be shown as a claim alone.

#### Scenario: A lane-admitted CIMD client asks for consent

- **WHEN** the consent page renders for a CIMD client whose host is not allowlisted
- **THEN** it shows the verified serving host separately from the client-supplied name

#### Scenario: A CIMD client declares a famous name

- **WHEN** a CIMD client's document names itself after another product
- **THEN** the consent page shows that name as the client's own claim beside the host that served the document, never as verified identity
