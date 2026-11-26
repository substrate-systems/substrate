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

### Requirement: Generic MCP Clients Are Admitted Without Certification

A client that no marketplace distributes SHALL be admissible without a promoted artifact, a configuration digest, a platform, or a cohort. Such a client SHALL carry admission mode `generic` and no `client_platform`, and its admission SHALL NOT consult per-platform cohort liveness, because a cohort exists only where a certified artifact does and no certified artifact can exist for a client nobody ships.

The generic arm SHALL be present in every admission predicate in the system — authorization, consent, owner attachment, invite admission, token exchange, bearer use, the MCP lookup, and refresh — so that a client admitted at one stage is admitted at all of them.

Pinned and host-allowlist admission SHALL be unchanged in behaviour. Adding the generic arm SHALL NOT admit a client of any other mode.

#### Scenario: A generic client authorizes and calls MCP

- **WHEN** an enabled generic client presents an exact redirect, resource, scopes, state and PKCE challenge, and the authenticated identity already owns a tenant
- **THEN** the client is admitted, a grant is issued, and the same client is admitted at token exchange, bearer use, the MCP lookup and refresh

#### Scenario: A generic client is refused without an invite

- **WHEN** a generic client authorizes for an identity that holds neither an unspent invite nor an existing tenant
- **THEN** no tenant, entitlement, grant or token is created, and the refusal does not disclose whether that identity is known

#### Scenario: Certified admission is unaffected

- **WHEN** a pinned or host-allowlist client authorizes while the generic lane is enabled
- **THEN** it is admitted on exactly the terms it was before
- **AND** withdrawing its host still stops a host-allowlist client at every stage

#### Scenario: A generic client is admitted where no platform cohort exists

- **WHEN** a generic client authorizes while no cohort is live for any platform
- **THEN** admission succeeds on the generic arm, because generic admission does not depend on cohort liveness

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

Registration SHALL follow RFC 7591 and register every client as a public client using the PKCE authorization code flow, with `token_endpoint_auth_method` of `none`. A request for a client-secret method SHALL be answered with `none`, as RFC 7591 permits; a request for a method that needs a client-held key SHALL be refused. Every redirect URI SHALL be an already-canonical https URL without credentials or fragment and within a bounded length, additionally permitting loopback http for local clients that are served from no host. The response SHALL report only what the server honours for the client.

Registration SHALL be rate limited per requesting address, keying an IPv6 address by its /64, and SHALL occupy a population partition separate from operator-registered and auto-registered CIMD clients, so that an anonymous flood exhausts only its own partition.

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
