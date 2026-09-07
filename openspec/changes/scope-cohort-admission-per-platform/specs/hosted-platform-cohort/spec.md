## ADDED Requirements

### Requirement: A cohort is live for a platform independently of other platforms

The system SHALL express, as authoritative certification and reporting state, that
a given client platform has a live promoted artifact bound to a live contract candidate. A
platform's cohort MUST NOT depend on any other platform having a live artifact.

#### Scenario: One platform is promoted

- **WHEN** a Claude artifact is live against a live candidate and no OpenAI artifact exists
- **THEN** the cohort is live for `claude`
- **AND** the cohort is not live for `openai`

#### Scenario: Both platforms are promoted

- **WHEN** live artifacts exist for both platforms against the same live candidate
- **THEN** the cohort is live for each platform independently
- **AND** the paired cohort projection continues to report that pairing

### Requirement: Platform certification does not authorize service clients

Ordinary service admission SHALL evaluate approved client identity and OAuth,
ownership and current service policy independently of platform certification.
A platform cohort MUST NOT admit an unapproved client or be required to admit an
approved one, including the allowed-host CIMD branch. A certification applies
only to its exact platform artifact and does not certify another platform.

#### Scenario: Claude client with only a Claude cohort

- **WHEN** an approved Claude client authorizes while only the Claude cohort is live
- **THEN** admission proceeds on ordinary service policy, not on the artifact

#### Scenario: OpenAI client with only a Claude cohort

- **WHEN** an approved OpenAI client authorizes while only the Claude cohort is live
- **THEN** admission may proceed on ordinary service policy without claiming OpenAI certification

#### Scenario: Admitted-host client with no cohort for its platform

- **WHEN** a valid unexpired client on an admitted CIMD host authorizes while no cohort is live for its platform
- **THEN** admission may proceed on ordinary service policy regardless of artifact cohorts

### Requirement: A single-platform cohort is promotable with evidence for that platform

Certification SHALL accept exactly the platforms being certified against an already-live runtime and require, for each, the same
clean-client evidence a paired promotion requires for it. Cross-client evidence equality
SHALL be enforced whenever two platforms are promoted together, and is inapplicable when
only one is.

#### Scenario: Single-platform promotion

- **WHEN** an already-live runtime receives a verified exact Claude artifact and Claude clean-client evidence
- **THEN** that artifact becomes certified without reactivating or changing the runtime
- **AND** the cohort is live for `claude` only

#### Scenario: Single-platform promotion with unverified evidence

- **WHEN** a single-platform promotion presents evidence that fails verification for that platform
- **THEN** certification is refused without changing the active runtime or existing certifications

#### Scenario: Paired promotion still cross-checks

- **WHEN** a paired certification claim is made for artifacts on both platforms against the same live runtime
- **THEN** the paired run, identity, and tenant evidence digests MUST name the same cohort
- **AND** a mismatch refuses the promotion

#### Scenario: Adding a second platform later

- **WHEN** a second platform is promoted against a candidate already live for one platform
- **THEN** the second artifact becomes live without retiring the first
- **AND** the cohort is thereafter live for both platforms
