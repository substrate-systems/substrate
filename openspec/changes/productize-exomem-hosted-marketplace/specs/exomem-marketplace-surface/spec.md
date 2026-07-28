## ADDED Requirements

### Requirement: Honest public Hosted product choice

The public Exomem surface SHALL distinguish the available self-hosted product from the invite-only Hosted service and SHALL NOT describe Hosted as hypothetical or zero-knowledge/end-to-end encrypted.

#### Scenario: Visitor compares deployment choices

- **WHEN** a visitor opens `/exomem`
- **THEN** the page presents self-hosted ownership and Hosted private alpha as distinct choices
- **AND** Hosted states that tenant cells process plaintext for search while storage and transport are encrypted

#### Scenario: Public marketplace channel is not live

- **WHEN** no exact live public install action exists for a client
- **THEN** the page offers the invite/private-alpha path
- **AND** it does not render a guessed directory URL or claim that channel is publicly available

#### Scenario: Public marketplace channel is live

- **WHEN** an exact sanitized client artifact and public installation URL are live
- **THEN** the page may expose that channel's install action with no tenant, token, cell, or secret material

### Requirement: Stable product policy and support surfaces

The service SHALL publish stable Exomem-specific privacy, terms, support, and setup pages suitable for users and provider reviewers.

#### Scenario: Reviewer opens required public URLs

- **WHEN** a reviewer visits `/exomem/privacy`, `/exomem/terms`, `/exomem/support`, or `/exomem/setup`
- **THEN** each route returns a readable product-specific page without authentication
- **AND** the sitemap contains each canonical URL

#### Scenario: Privacy boundary is described

- **WHEN** a visitor reads the Exomem privacy page
- **THEN** it describes account, billing, knowledge content, and operational metadata processing; purposes; retention; subprocessors or categories; operator access; security; portability; deletion; rights; and a contact
- **AND** it explains that the isolated cell sees plaintext to search and serve the user's store

#### Scenario: Terms are product-specific

- **WHEN** a visitor reads the Exomem terms page
- **THEN** it covers alpha eligibility, user data ownership and processing license, acceptable use, availability, payment where enabled, export/deletion, suspension, warranties, liability, and contact
- **AND** it does not reuse Endstate-specific licensing terms as Exomem's agreement

### Requirement: Install-and-login setup journey

The Hosted setup surface SHALL lead with installing or connecting an approved client entry, completing one OAuth sign-in, and using Exomem through its governed tools and bundled skills.

#### Scenario: User follows normal setup

- **WHEN** a user follows Hosted setup for Claude, ChatGPT, or Codex
- **THEN** the primary path requires no local vault path, manual MCP JSON editing, API-token copy, or repeated explicit instruction to use Exomem

#### Scenario: Chat surface does not activate bundled skills

- **WHEN** a supported chat surface connects the remote MCP server but does not activate bundled skills
- **THEN** setup presents concise global custom instructions as a labelled fallback
- **AND** it does not represent that fallback as part of the Hosted security or storage boundary

### Requirement: Exact OpenAI domain verification

The service SHALL expose OpenAI's well-known application challenge only from an operator-held deployment value and SHALL never commit, infer, log, or accept that value from the request.

#### Scenario: Valid challenge is configured

- **WHEN** OpenAI requests `/.well-known/openai-apps-challenge` and a valid challenge is configured
- **THEN** the response is status 200 with exactly that value as plain text
- **AND** it is marked non-cacheable

#### Scenario: Challenge is absent or unsafe

- **WHEN** the configured value is missing, blank, newline-bearing, or outside the accepted length
- **THEN** the route fails closed without echoing any supplied or configured value

#### Scenario: Caller supplies a challenge

- **WHEN** a caller includes a query, header, or body value that resembles a domain challenge
- **THEN** the route ignores it and uses only deployment configuration

### Requirement: Side-effect-free OAuth discovery

The Hosted OAuth metadata routes SHALL return canonical metadata using only validated public configuration and SHALL perform no database, tenant, invite, capacity, provisioning, or cell operation.

#### Scenario: Protected-resource metadata is requested

- **WHEN** a client requests the canonical protected-resource metadata URL
- **THEN** it receives the exact Hosted MCP resource and authorization-server references without authentication or database access

#### Scenario: Authorization-server metadata is requested

- **WHEN** a client requests the canonical authorization-server metadata URL
- **THEN** it receives the exact authorization, token, revocation, PKCE, and client-registration capabilities without authentication or database access

#### Scenario: Public origin is invalid

- **WHEN** required public-origin configuration is absent or unsafe
- **THEN** metadata fails closed with a content-free diagnostic
- **AND** no fallback origin is inferred from an untrusted request header

### Requirement: Authorization challenge precedes protected work

The Hosted MCP endpoint SHALL validate a present browser Origin and the bearer request shape before protected work, and SHALL return the canonical OAuth authorization challenge before any database-backed rate-limit, token, tenant, entitlement, or cell operation for missing or malformed authorization.

#### Scenario: Origin is absent

- **WHEN** a server-side MCP client omits Origin
- **THEN** Origin validation passes
- **AND** the request continues to the ordinary authorization-shape check

#### Scenario: Origin is exactly allowed

- **WHEN** a client sends the canonical public origin or an exact origin configured in `EXOMEM_MCP_ALLOWED_ORIGINS`
- **THEN** Origin validation passes without a database operation

#### Scenario: Origin is unsafe or unlisted

- **WHEN** a client sends `null`, a wildcard, malformed origin, credentials, a path, query or fragment, an unlisted origin, a neighboring subdomain, or the wrong port
- **THEN** it receives a content-free 403 before rate limiting, token lookup, tenant work, or body processing

#### Scenario: Authorization is absent

- **WHEN** a client calls the Hosted MCP endpoint without Authorization
- **THEN** it receives status 401 and the canonical `WWW-Authenticate` resource-metadata challenge
- **AND** no database-backed rate limit, token, or tenant operation occurs

#### Scenario: Authorization is malformed

- **WHEN** a client sends a malformed or unsupported Authorization value
- **THEN** it receives a content-free OAuth error without a database or tenant operation

#### Scenario: Bearer token is structurally valid

- **WHEN** a client sends a structurally valid bearer token
- **THEN** the existing durable IP rate limit and fail-closed token, tenant, entitlement, and cell validation remain authoritative

### Requirement: Redacted marketplace production preflight

The repository SHALL provide a deterministic preflight that verifies the public product and policy URLs, canonical OAuth discovery, authorization challenge, domain proof, and optional authenticated MCP initialization/tool discovery without exposing credentials or knowledge content.

#### Scenario: Public preflight succeeds

- **WHEN** every unauthenticated production surface matches the canonical contract
- **THEN** the preflight verifies an attacker Origin is rejected and emits a timestamped redacted evidence document with route status, semantic page and protocol contract digests, and no response content from the knowledge store

#### Scenario: Authenticated preflight succeeds

- **WHEN** an operator supplies a reviewer token only through the documented environment variable
- **THEN** the preflight verifies MCP initialization and tool discovery
- **AND** it emits only protocol metadata, tool names/counts, and digests

#### Scenario: A dependency is unhealthy

- **WHEN** any required route returns a 4xx/5xx unexpectedly, redirects off-origin, mismatches canonical metadata, or times out
- **THEN** preflight fails with the route and stable failure class
- **AND** it does not print tokens, challenge values, tenant identifiers, or response bodies

### Requirement: Marketplace claims require live artifact evidence

The public Hosted deployment SHALL keep marketplace installation claims and links bound to the existing exact live client-artifact records.

#### Scenario: Artifact is pending, failed, or stale

- **WHEN** a client artifact is not live for its exact package, compatibility, identity, and evidence bindings
- **THEN** public and owner surfaces do not offer its marketplace installation action

#### Scenario: Exact artifact is live

- **WHEN** an artifact passes the existing signed promotion contract and its sanitized public install URL is configured
- **THEN** the corresponding owner installation action is available
- **AND** publication of a public page action cannot disclose an owner or tenant binding
