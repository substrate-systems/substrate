## ADDED Requirements

### Requirement: Operator-controlled reviewer credentials

The service SHALL let an authenticated Exomem operator create, rotate, inspect, and revoke a generated marketplace reviewer credential for a supported provider and SHALL bind it to one dedicated, already-provisioned owner and immutable reviewer-purpose tenant.

#### Scenario: Operator creates reviewer access

- **WHEN** an authorized operator selects `openai` or `anthropic`, an existing usable reviewer-purpose owner/tenant, a valid fixture version and payload digest, and a bounded future expiry
- **THEN** the service generates a high-entropy username and password
- **AND** returns both plaintext values exactly once
- **AND** stores only a username digest and Argon2id password hash

#### Scenario: Target account is not already usable

- **WHEN** the selected owner/tenant does not exist, lacks the immutable reviewer-purpose marker, is not an owner binding, lacks a usable entitlement/cell state, is deleted, blocked, or is otherwise ineligible for normal Hosted OAuth
- **THEN** credential creation fails without provisioning or mutating that account

#### Scenario: Dedicated reviewer tenant is created

- **WHEN** an operator issues and a dedicated account redeems a reviewer-purpose invitation
- **THEN** the new tenant is created with an immutable reviewer-purpose marker
- **AND** an existing ordinary customer tenant cannot be relabelled or selected for reviewer credentials

#### Scenario: Provider credential is rotated

- **WHEN** an operator creates a replacement for a provider with an active or expired credential
- **THEN** the prior credential is revoked atomically
- **AND** only the new plaintext credential is returned

### Requirement: Narrow reviewer authentication

The service SHALL expose reviewer authentication only inside a valid active Hosted OAuth continuation and only when the reviewer-access feature flag is enabled.

#### Scenario: Valid reviewer signs in during OAuth

- **WHEN** the feature is enabled, the request is same-origin JSON, the OAuth continuation is active, its trusted client platform matches the credential provider, the credential is valid and unexpired, and its bound account remains usable
- **THEN** the service creates an ordinary browser session for exactly the pre-bound owner and tenant
- **AND** atomically binds both the session and OAuth continuation to that credential
- **AND** the existing authorization confirmation flow continues

#### Scenario: Credential provider does not match the OAuth client

- **WHEN** an Anthropic credential is presented for an OpenAI client continuation or an OpenAI credential is presented for an Anthropic client continuation
- **THEN** no session or continuation binding is created
- **AND** the route returns the generic authentication failure

#### Scenario: Reviewer endpoint would provision state

- **WHEN** reviewer authentication is attempted
- **THEN** it MUST NOT create a user, tenant, entitlement, lifecycle operation, cell, volume, capacity allocation, invitation, or knowledge content

#### Scenario: Reviewer access is disabled or outside OAuth

- **WHEN** the feature flag is absent or false, or no valid OAuth continuation exists
- **THEN** no session is created
- **AND** the public response is indistinguishable from another credential failure

### Requirement: Enumeration-resistant abuse controls

The service SHALL bound reviewer password verification with durable controls and SHALL not expose whether a username, provider credential, tenant, or feature state exists.

#### Scenario: Authentication is wrong, expired, revoked, disabled, or rate-limited

- **WHEN** any credential or control check fails after a structurally valid request
- **THEN** the route returns the same status, body shape, cache policy, and referrer policy
- **AND** no username, password, digest, tenant ID, user ID, provider binding, or failure detail is logged or returned

#### Scenario: Unknown username is checked

- **WHEN** the presented username has no active credential row
- **THEN** the service still performs a bounded dummy Argon2id verification after durable pre-KDF limits
- **AND** returns the generic authentication failure

#### Scenario: Abuse limits are unavailable

- **WHEN** durable rate-limit state cannot be checked
- **THEN** reviewer authentication fails closed before password verification or session creation

### Requirement: Complete reviewer revocation

The service SHALL tag sessions created by reviewer credentials and SHALL revoke the credential's active access graph when an operator rotates or revokes it.

#### Scenario: Reviewer credential is revoked

- **WHEN** an operator revokes an active provider credential
- **THEN** the credential can no longer authenticate
- **AND** its reviewer sessions, pending authorization state, authorization codes, grants, token families, refresh tokens, and access tokens are made unusable atomically
- **AND** no permanent account block is created and the tenant is not deleted

#### Scenario: Revocation is retried

- **WHEN** the same provider credential revocation is repeated
- **THEN** the operation is idempotent
- **AND** no unrelated customer session or tenant is changed

#### Scenario: Reviewer credential expires

- **WHEN** an attributed reviewer credential reaches its expiry without an explicit operator revocation
- **THEN** its sessions, authorization completion, code exchange, refresh, and MCP access are rejected
- **AND** session and token-family expiry never extends beyond the credential expiry

### Requirement: Fixture-bound and secret-free operations

The service SHALL associate reviewer credentials with a versioned generic fixture contract and SHALL keep provider credentials and sample knowledge out of repository artifacts, public evidence, and application logs.

#### Scenario: Operator prepares a reviewer tenant

- **WHEN** reviewer access is created
- **THEN** the stored metadata names the expected fixture version and canonical payload digest
- **AND** the runbook requires seeding content through the ordinary governed Exomem path before sharing credentials

#### Scenario: Marketplace review completes

- **WHEN** a provider reviewer or clean test account exercises Hosted Exomem
- **THEN** evidence records only safe protocol metadata and digests
- **AND** content-bearing proof remains in the existing native-client acceptance workflow rather than the public control-plane logs
