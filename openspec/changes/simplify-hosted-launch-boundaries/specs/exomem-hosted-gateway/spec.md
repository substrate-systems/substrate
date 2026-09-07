## ADDED Requirements

### Requirement: MCP deployment location does not change client authority

The public MCP resource SHALL preserve its canonical URL, audience, issuer, supported protocol, challenges, schemas and result envelopes when served by a separately deployed shared gateway. Public routing headers MUST NOT override those canonical identities or grant trusted client-IP authority. Deploying or rolling back the gateway MUST NOT require minting replacement grants or forwarding public bearer credentials to cells. The edge MUST disable response caching for this resource, including errors and streams.

#### Scenario: Gateway origin changes

- **WHEN** the configured edge route moves the existing MCP resource between supported adapters
- **THEN** existing valid grants retain their exact audience and authority
- **AND** unrelated website, OAuth and transfer routes retain their existing destinations

#### Scenario: Two principals traverse the edge

- **WHEN** two differently authorized principals call the same MCP URL with identical request shapes
- **THEN** the edge forwards each request independently without serving a cached protected result
- **AND** caller-controlled forwarded-source headers cannot bypass the gateway's trusted-source or per-identity rate limits

#### Scenario: Streaming client disconnects

- **WHEN** a client cancels an in-flight streamed MCP request or a gateway instance drains
- **THEN** cancellation and bounded drain propagate through the canonical transport without cross-request state leakage or unbounded buffering

### Requirement: Immutable contract caching cannot cache mutable authority

The gateway SHALL reuse validated immutable contract-derived schemas only under their complete registered contract identity and bounded cache limits. Each protected request MUST independently enforce current token, client, grant, ownership, entitlement and routing policy. Database unavailability MUST fail closed for those decisions and MUST NOT authorize from an old successful request.

#### Scenario: Cached tools outlive grant revocation

- **WHEN** a contract remains cached after the corresponding requester's grant is revoked or tenant is suspended
- **THEN** the next protected request is denied by current policy before forwarding

### Requirement: Local private routing is confined to the authoritative cell

A cluster-local gateway transport SHALL derive the cell path only from the authoritative validated mapping and use one configured private ingress origin. It MUST reject unexpected stored endpoint hosts/paths, redirect responses and caller-controlled origins. The remote transport MUST remain HTTPS-only. Both transports MUST retain unique cell authentication and trusted principal/cell/protocol binding.

#### Scenario: Public request supplies internal routing headers

- **WHEN** an authenticated public caller supplies a private origin, cell selector, Host override or expected-contract header
- **THEN** it is rejected or stripped and cannot influence the authoritative destination or trusted forwarding context

#### Scenario: Stored endpoint is outside the deployment mapping

- **WHEN** an endpoint does not match the configured control hostname and mapped-cell path
- **THEN** local transport fails before any request is sent

### Requirement: Single-hop command forwarding requires command-time contract enforcement

The gateway SHALL omit the per-command contract fetch only when the approved compatibility contract advertises the expected-contract command boundary. It MUST send the complete approved expected tuple on that boundary. A mismatch MUST fail closed without retrying through a weaker route. Older approved runtimes MUST retain the existing contract verification path until retired.

#### Scenario: Compatible cell executes a command

- **WHEN** an authorized invocation targets an approved runtime supporting command-time binding
- **THEN** the gateway sends one private command request containing its expected tuple and no separate contract GET

#### Scenario: Bound contract differs at execution

- **WHEN** the cell rejects a changed or mismatched expected tuple
- **THEN** the gateway returns the stable compatibility failure and does not try a legacy route or another cell
