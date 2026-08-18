## MODIFIED Requirements

### Requirement: Client ID Metadata Document admission by host

A client admitted by Client ID Metadata Document SHALL be eligible on the strength of the host that serves its document, independent of any promoted artifact's `oauth_client_config_sha256`. The allowlist of admitted hosts SHALL be authoritative server state readable by the admission queries themselves, so that every admission decision in the system evaluates one identical predicate. Admission SHALL additionally require that the client's cached metadata has not expired and that a live cohort exists for the client's platform, evaluated against that platform's cohort alone and never against any other platform's.

#### Scenario: Admitted host with a live cohort for its platform

- **WHEN** a client whose configuration digest matches no promoted artifact identifies by a valid metadata document served from an admitted host, and a live cohort exists for its platform
- **THEN** admission proceeds

#### Scenario: Host is not on the allowlist

- **WHEN** a client identifies by a metadata document served from a host that is not admitted
- **THEN** admission is refused

#### Scenario: Cached metadata has expired

- **WHEN** an admitted-host client authorizes with cached metadata past its expiry
- **THEN** admission is refused

#### Scenario: No live cohort exists for the platform

- **WHEN** an admitted-host client authorizes while no live cohort exists for its platform
- **THEN** admission is refused
- **AND** a live cohort belonging to a different platform does not satisfy the requirement
