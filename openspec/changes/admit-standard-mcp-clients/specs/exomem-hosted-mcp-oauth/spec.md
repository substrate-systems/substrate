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

A client admitted by Client ID Metadata Document SHALL be eligible on the strength of the host that serves its document, independent of any promoted artifact's `oauth_client_config_sha256` or live platform artifact cohort, when either the host is on the admitted-host allowlist or the generic lane is enabled. The allowlist of admitted hosts SHALL be authoritative server state readable by the admission queries themselves, so that every admission decision in the system evaluates one identical predicate. Admission SHALL additionally require enabled client state and unexpired validated metadata. Ordinary authorization SHALL enforce current owner, consent, entitlement and token policy; new provisioning SHALL atomically select an eligible live runtime target. Transient cell readiness MUST NOT invalidate otherwise valid ordinary authorization or refresh; tool execution SHALL separately require a ready compatible bound cell.

A lane-admitted CIMD client — one whose host is not allowlisted — SHALL carry no `client_platform` and no platform-bound configuration digest, and SHALL be counted with the generic partition rather than the allowlisted auto-registered partition. A CIMD client whose host is allowlisted SHALL be admitted even while the lane is disabled.

Approved pinned registrations SHALL remain eligible without a certified artifact. Independently governed provider-review bootstrap authority SHALL retain its separate purpose and limits: lane admission SHALL NOT entitle any client to reviewer credential redemption.

#### Scenario: A previously unseen connector on an admitted host authorizes

- **WHEN** a client whose configuration digest matches no promoted artifact identifies by a valid metadata document served from a currently admitted host and satisfies ordinary service policy
- **THEN** the client is admitted and authorization proceeds normally

#### Scenario: A connector on an unlisted host authorizes while the lane is enabled

- **WHEN** a client identifies by a valid HTTPS metadata document whose host is not allowlisted, while the generic lane is enabled, and satisfies ordinary service policy
- **THEN** the client is admitted and authorization proceeds normally, and its stored registration carries no platform

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

- **WHEN** a CIMD continuation is resolved while its host is admitted but that authority is withdrawn — by allowlist deletion and, for a lane-admitted host, by lane withdrawal — before atomic first-invite admission
- **THEN** the transaction rechecks current client and host authority and refuses admission
- **AND** it does not consume the invite or create tenant, grant, capacity or provisioning state

#### Scenario: Lane is withdrawn after a lane-admitted client connected

- **WHEN** an operator disables the lane while an unlisted-host CIMD client holds live grants
- **THEN** that client stops being admitted at every stage — authorization, consent, token exchange, refresh and the MCP lookup — without any per-client action
- **AND** allowlisted CIMD, pinned and operator clients are unaffected

### Requirement: First Authorization Registers An Allowlisted CIMD Client

The authorization endpoint SHALL register an unknown CIMD client on its first authorization attempt when the presented `client_id` is an HTTPS URL whose host is on the admitted-host allowlist or, only while the generic lane is enabled, on any other host. The lane state SHALL be evaluated before any metadata fetch, so that a disabled lane never causes an outbound request to an unlisted host. Registration SHALL validate the metadata document through the same fetch path used by operator-managed registration, including its protections against private and non-HTTPS network addresses, and SHALL store the client with its document digest, fetch time, and TTL.

An allowlisted host's registration SHALL store the allowlist's platform and the platform-bound configuration digest. A lane-admitted host's registration SHALL store no platform and no platform-bound digest, keep the serving host as `cimd_host`, and occupy the generic partition. A first-authorization registration SHALL NOT create, modify, enable or rewrite a client row of any other admission mode or registration provenance.

Because this is an unauthenticated write path, it SHALL be rate limited per client address, and it MUST NOT create, modify, or disclose user, tenant, entitlement, invite, or grant state.

#### Scenario: Unknown connector on an admitted host authorizes for the first time

- **WHEN** an unrecognized `client_id` is an HTTPS URL on an admitted host and its metadata document validates
- **THEN** exactly one client row is created with CIMD admission and the document's digest, fetch time and TTL
- **AND** the authorization transaction continues without a second round trip from the client

#### Scenario: Unknown connector on an unlisted host authorizes while the lane is enabled

- **WHEN** an unrecognized `client_id` is an HTTPS URL on an unlisted host, the generic lane is enabled, and its metadata document validates
- **THEN** exactly one client row is created with CIMD admission, no platform, no platform-bound digest, and a slot in the generic partition

#### Scenario: Unknown connector on an unlisted host authorizes while the lane is disabled

- **WHEN** an unrecognized `client_id` is an HTTPS URL on an unlisted host and the generic lane is disabled
- **THEN** no metadata fetch is attempted, no client row is created, and the response is indistinguishable from any other unknown client

#### Scenario: Registration is attempted repeatedly from one address

- **WHEN** registration attempts from a single client address exceed the configured rate
- **THEN** further attempts are refused without registering a client or revealing which hosts are admitted

#### Scenario: Metadata fetch targets an unsafe address

- **WHEN** a CIMD document's host resolves to a private, loopback, or non-HTTPS network address — allowlisted or not
- **THEN** registration fails before any client row is created

#### Scenario: A registered client's document later changes

- **WHEN** a client that is already registered presents a metadata document that no longer matches its stored digest
- **THEN** the stored registration is revalidated rather than silently trusted
- **AND** admission fails closed if the new document is invalid

### Requirement: Generic MCP Clients Are Admitted Without Certification

A client that no marketplace distributes SHALL be admissible without a promoted artifact, a configuration digest, a platform, or a cohort. Such a client SHALL carry admission mode `generic` and no `client_platform`, or — for a lane-admitted CIMD client — admission mode `cimd` with no `client_platform`. Its admission SHALL NOT consult per-platform cohort liveness, because a cohort exists only where a certified artifact does and no certified artifact can exist for a client nobody ships.

The generic arm SHALL be present in every admission predicate in the system — authorization, consent, owner attachment, invite admission, token exchange, bearer use, the MCP lookup, and refresh — so that a client admitted at one stage is admitted at all of them.

Pinned and host-allowlist admission SHALL be unchanged in behaviour. Adding the generic arm SHALL NOT admit a client of any other mode.

#### Scenario: A generic client authorizes and calls MCP

- **WHEN** an enabled generic client presents an exact redirect, resource, scopes, state and PKCE challenge, and the authenticated identity already owns a tenant
- **THEN** the client is admitted, a grant is issued, and the same client is admitted at token exchange, bearer use, the MCP lookup and refresh

#### Scenario: A generic client is refused without an invite

- **WHEN** a generic client authorizes for an identity that holds neither an unspent invite nor an existing tenant
- **THEN** no grant, code or token is issued

#### Scenario: A generic client authorizes while no cohort is live for any platform

- **WHEN** a generic client authorizes while no cohort is live for any platform
- **THEN** admission succeeds on the generic arm, because generic admission does not depend on cohort liveness

#### Scenario: A lane-admitted CIMD client redeems no reviewer credential

- **WHEN** a client admitted only through the generic lane presents or inherits reviewer bootstrap authority
- **THEN** the reviewer path refuses it, because reviewer redemption requires certified admission

### Requirement: Generic Admission Is Disabled Until Deliberately Enabled

The generic lane SHALL be governed by authoritative server state that the admission predicates read directly, not by process configuration alone, so that one operator action enables or withdraws it everywhere atomically. It SHALL be disabled by default.

While disabled, the authorization server metadata document SHALL NOT advertise a `registration_endpoint`, the registration endpoint SHALL refuse every request indistinguishably from an unknown route, no previously registered generic client SHALL be admitted at any stage, and no CIMD client from an unlisted host SHALL be registered or admitted — with no metadata fetch performed for it.

#### Scenario: The lane is disabled

- **WHEN** any generic client authorizes, exchanges, refreshes or calls MCP while the lane is disabled
- **THEN** every stage refuses, and metadata advertises no registration endpoint

#### Scenario: An unlisted CIMD client arrives while the lane is disabled

- **WHEN** a client identifies by an HTTPS metadata document on a host outside the allowlist while the lane is disabled
- **THEN** authorization fails without fetching that host's document, registering a client, or disclosing the lane's state

#### Scenario: The lane is withdrawn after clients registered

- **WHEN** an operator disables the lane while generic or lane-admitted clients hold live grants
- **THEN** those clients stop being admitted at every stage without any per-client action
- **AND** certified and allowlisted CIMD clients are unaffected

### Requirement: Auto-Registered Clients Cannot Exhaust Operator Client Capacity

The bound on stored OAuth clients SHALL be partitioned so that clients created by unauthenticated first-authorization registration are counted separately from operator-managed clients. Self-registered clients SHALL be further split so that allowlisted CIMD registrations count in an auto-registered partition while dynamic registrations and lane-admitted CIMD clients count in the generic partition. Exhausting either self-registration partition MUST NOT prevent an operator from registering or updating a client, and MUST NOT disable, evict, or rewrite any existing operator-managed client.

#### Scenario: Auto-registration partition is full

- **WHEN** the number of allowlisted auto-registered CIMD clients reaches its bound and a new unknown client authorizes on such a host
- **THEN** registration is refused
- **AND** operator client registration and every already-admitted client continue to work

#### Scenario: Generic partition is full of lane-admitted CIMD clients

- **WHEN** lane-admitted CIMD clients and dynamic registrations together reach the generic bound and a new unknown client registers or authorizes on an unlisted host
- **THEN** registration is refused
- **AND** allowlisted CIMD and operator registrations continue to work

#### Scenario: Operator registers a client while auto-registrations exist

- **WHEN** an operator registers or updates a client while auto-registered clients are stored
- **THEN** the operation succeeds on its own partition's bound, independent of how many auto-registered clients exist

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
