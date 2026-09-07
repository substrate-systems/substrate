## MODIFIED Requirements

### Requirement: Client ID Metadata Document admission by host

A client admitted by Client ID Metadata Document SHALL be eligible on the strength of its approved host and validated unexpired metadata, independent of any promoted artifact or platform cohort. The allowlist of admitted hosts SHALL be authoritative server state readable by the admission queries themselves, so that every ordinary authorization, code exchange, access and refresh decision evaluates one identical service-client predicate. Identity, ownership, consent, redirect, PKCE, resource, scopes and current account/entitlement policy remain mandatory. Artifact certification MUST NOT be a service-admission predicate.

#### Scenario: Admitted host without a certified artifact

- **WHEN** a client whose configuration digest matches no promoted artifact identifies by valid unexpired metadata served from an admitted host and satisfies ordinary service policy
- **THEN** admission proceeds

#### Scenario: Host is not on the allowlist

- **WHEN** a client identifies by a metadata document served from a host that is not admitted
- **THEN** admission is refused

#### Scenario: Cached metadata has expired

- **WHEN** an admitted-host client authorizes with cached metadata past its expiry
- **THEN** admission is refused

#### Scenario: No certified cohort exists for the platform

- **WHEN** an approved admitted-host client authorizes while no certified artifact exists for either platform
- **THEN** ordinary service admission may proceed subject to the unchanged identity and OAuth policy
- **AND** no platform receives a certification or publication claim from that authorization
