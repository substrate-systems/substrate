## ADDED Requirements

### Requirement: Operators issue and revoke per-cell service credentials

The control plane SHALL let an operator holding the admin token issue a service credential for one tenant and one product principal of the form `service:<name>`. It SHALL store only the credential secret's SHA-256 digest and SHALL return the secret only in the issue response. It SHALL refuse a third live credential for the same tenant and principal with `SERVICE_CREDENTIAL_LIMIT`. Revoking a credential SHALL take effect on the next gateway request that presents it.

#### Scenario: A product rotates its credential

- **WHEN** an operator issues a second credential for a tenant and principal that already hold one live credential
- **THEN** both credentials reach the tenant's cell
- **AND** after the operator revokes the first credential, the gateway refuses it with 401 and still admits the second

#### Scenario: A third live credential is refused

- **WHEN** an operator issues a credential for a tenant and principal that already hold two live credentials
- **THEN** the request fails with `SERVICE_CREDENTIAL_LIMIT` and no credential is created

#### Scenario: The secret is shown once

- **WHEN** an operator lists a tenant's service credentials
- **THEN** the list names each credential's id, principal, creation and revocation times
- **AND** it contains no secret and no digest

### Requirement: The Cloud gateway admits a service credential for its tenant's cell only

The Cloud gateway SHALL accept a live service credential on the MCP path and SHALL route the request only to the cell of the credential's tenant. It SHALL apply the same desired-state gate, derived cell bearer and origin proof as for an access token. The proof's client SHALL be the credential's principal.

#### Scenario: A product reaches its tenant's cell

- **WHEN** a product calls a tool through the gateway with a live service credential
- **THEN** the request reaches only the cell of the credential's tenant, with the derived cell bearer and an origin proof whose client is the credential's principal

#### Scenario: A product cannot select another cell

- **WHEN** a request with a live service credential carries a path, query or header naming another tenant or cell
- **THEN** the gateway rejects the selector or ignores it, and routes only to the credential's tenant's cell

#### Scenario: A revoked credential reaches nothing

- **WHEN** a request presents a revoked service credential
- **THEN** the gateway answers 401 and contacts no cell

### Requirement: The Cloud gateway refuses an invalid service credential before any cell

The Cloud gateway SHALL answer 401, before it contacts any cell, for a service credential that is unknown or revoked, or whose tenant is pending deletion or deleted. It SHALL never accept a service credential as an access token, nor an access token as a service credential.

#### Scenario: An access token is not a service credential

- **WHEN** a request presents an access token with the service credential prefix, or a service credential without it
- **THEN** the gateway answers 401 and contacts no cell

### Requirement: The Cloud gateway forwards authenticated cell discovery

The Cloud gateway SHALL answer `GET /.well-known/exomem-cell` for a caller authenticated with an access token or a service credential. It SHALL return the bytes that the caller's cell serves at that path unchanged, with `private, no-store`. It SHALL answer an unauthenticated request with 401 and contact no cell.

#### Scenario: A product reads its cell's identity

- **WHEN** a product requests the discovery path with a live service credential
- **THEN** the gateway returns the discovery document of the credential's tenant's cell, byte for byte

#### Scenario: Unauthenticated discovery reaches no cell

- **WHEN** a request for the discovery path carries no valid credential
- **THEN** the gateway answers 401 and contacts no cell
