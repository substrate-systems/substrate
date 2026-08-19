## MODIFIED Requirements

### Requirement: OAuth Authorization Is Client-Bound And Exomem-Owned

The authorization server SHALL implement authorization code with PKCE S256, exact redirect URI binding, short-lived single-use codes, CSRF-safe browser state, resource-indicator/audience binding, explicit read/write scopes, and the client registration mechanisms proven necessary by the promoted hosts. It MUST NOT accept or pass through another provider's access token as an Exomem credential. Client admission SHALL be bounded by a promoted artifact's pinned configuration digest, an operator-curated allowlist of hosts trusted to serve Client ID Metadata Documents, or — only while the generic lane is enabled in authoritative server state — dynamic registration under a bounded generic admission mode. Generic admission SHALL NOT confer any authority over a tenant: a generic client reaches one only where an unspent invite or an existing ownership already entitles the authenticated identity.

#### Scenario: Approved public client authorizes correctly

- **WHEN** a promoted client presents an approved pre-registration, validated HTTPS Client ID Metadata Document, or explicitly enabled bounded registration with an exact redirect, resource, scopes, state, and PKCE challenge
- **THEN** the server begins one short-lived Exomem authorization transaction bound to those values

#### Scenario: Authorization code is intercepted or replayed

- **WHEN** a code is exchanged with a wrong client, redirect, resource, verifier, after expiry, or after prior use
- **THEN** token issuance fails without revealing identity, invite, tenant, or grant state

#### Scenario: Client metadata is unsafe or unapproved

- **WHEN** metadata resolution targets a private/non-HTTPS address, exceeds fetch bounds, redirects outside policy, mismatches its URL client ID, declares an unapproved redirect, or uses a disabled registration mechanism
- **THEN** authorization fails before user, entitlement, tenant, token, or infrastructure state is created

#### Scenario: Client is served by a host outside the allowlist

- **WHEN** an unknown client identifies by an HTTPS Client ID Metadata Document whose host is not on the admitted-host allowlist and which matches no promoted artifact's configuration digest
- **THEN** authorization fails without registering a client, fetching that host's metadata, or disclosing whether any other client is admitted

#### Scenario: Upstream identity service is unavailable after authorization

- **WHEN** an already-authorized client refreshes or calls MCP while the email or upstream login provider is unavailable
- **THEN** Exomem-owned token and policy state remains authoritative
- **AND** no new upstream provider token is minted for that client request

## ADDED Requirements

### Requirement: Generic MCP Clients Are Admitted Without Certification

A client that no marketplace distributes SHALL be admissible without a promoted artifact, a configuration digest, a platform, or a cohort. Such a client SHALL carry admission mode `generic` and no `client_platform`, and its admission SHALL NOT consult per-platform cohort liveness, because a cohort exists only where a certified artifact does and no certified artifact can exist for a client nobody ships.

The generic arm SHALL be present in every admission predicate in the system — authorization, consent, owner attachment, invite admission, token exchange, bearer use, the MCP lookup, and refresh — so that a client admitted at one stage is admitted at all of them.

Pinned-digest and host-allowlist admission SHALL be unchanged in behaviour. A certified client SHALL still require a live cohort for its own platform.

#### Scenario: A generic client authorizes and calls MCP

- **WHEN** an enabled generic client presents an exact redirect, resource, scopes, state and PKCE challenge, and the authenticated identity already owns a tenant
- **THEN** the client is admitted, a grant is issued, and the same client is admitted at token exchange, bearer use, the MCP lookup and refresh

#### Scenario: A generic client is refused without an invite

- **WHEN** a generic client authorizes for an identity that holds neither an unspent invite nor an existing tenant
- **THEN** no tenant, entitlement, grant or token is created, and the refusal does not disclose whether that identity is known

#### Scenario: Certified admission is unaffected

- **WHEN** a pinned-digest or host-allowlist client authorizes while the generic lane is enabled
- **THEN** it is admitted on exactly the terms it was before, still requiring a live cohort for its own platform

#### Scenario: A generic client is refused where no platform cohort exists

- **WHEN** a generic client authorizes while no cohort is live for any platform
- **THEN** admission succeeds on the generic arm, because generic admission does not depend on cohort liveness
- **AND** a certified client in the same state is still refused

### Requirement: Generic Admission Is Disabled Until Deliberately Enabled

The generic lane SHALL be governed by authoritative server state that the admission predicates read directly, not by process configuration alone, so that one operator action enables or withdraws it everywhere atomically. It SHALL be disabled by default.

While disabled, the authorization server metadata document SHALL NOT advertise a `registration_endpoint`, the registration endpoint SHALL refuse every request indistinguishably from an unknown route, and no previously registered generic client SHALL be admitted at any stage.

#### Scenario: The lane is disabled

- **WHEN** any generic client authorizes, exchanges, refreshes or calls MCP while the lane is disabled
- **THEN** every stage refuses, and metadata advertises no registration endpoint

#### Scenario: The lane is withdrawn after clients registered

- **WHEN** an operator disables the lane while generic clients hold live grants
- **THEN** those clients stop being admitted at every stage without any per-client action
- **AND** certified clients are unaffected

### Requirement: Dynamic Client Registration Is Bounded And Non-Enumerating

Registration SHALL follow RFC 7591, accept only clients requesting PKCE-capable authorization code flow with `token_endpoint_auth_method` of `none`, and validate every redirect URI as https without credentials or fragment and within a bounded length, additionally permitting loopback http for local clients that are served from no host.

Registration SHALL be rate limited per requesting address, and SHALL occupy a population partition separate from operator-registered and auto-registered CIMD clients, so that an anonymous flood exhausts only its own partition.

A registration request SHALL NOT be able to create, modify, enable or rewrite a client of any other admission mode. Every failure SHALL return one indistinguishable response, disclosing nothing about existing clients, admitted hosts, or whether the lane is enabled.

#### Scenario: An unknown client registers and then authorizes

- **WHEN** a previously unseen MCP client registers with a valid https or loopback redirect while the lane is enabled
- **THEN** it receives a client identifier and may immediately begin one authorization transaction

#### Scenario: Registration is flooded

- **WHEN** registrations arrive beyond the per-address rate limit or beyond the generic population bound
- **THEN** further registrations are refused, and operator and CIMD client capacity remain unaffected

#### Scenario: Registration targets an existing client

- **WHEN** a registration request names or collides with an operator-managed, bootstrap-pinned, or auto-registered CIMD client
- **THEN** that client is left exactly as it was, and the response is indistinguishable from any other refusal

#### Scenario: Registration declares an unsafe redirect

- **WHEN** a registration declares a non-https non-loopback redirect, a redirect carrying credentials or a fragment, or an over-long redirect
- **THEN** registration fails and no client row is written
