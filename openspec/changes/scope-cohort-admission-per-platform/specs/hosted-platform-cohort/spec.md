## ADDED Requirements

### Requirement: A cohort is live for a platform independently of other platforms

The system SHALL express, as authoritative server state readable by admission queries, that
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

### Requirement: A platform cohort admits only its own platform's clients

Admission SHALL evaluate a client against the cohort for that client's own
`client_platform`. A live cohort for one platform MUST NOT admit a client of another
platform by any branch, including the admitted-host CIMD branch.

#### Scenario: Claude client with only a Claude cohort

- **WHEN** a Claude client authorizes while only the Claude cohort is live
- **THEN** admission proceeds on the strength of the Claude artifact

#### Scenario: OpenAI client with only a Claude cohort

- **WHEN** an OpenAI client authorizes while only the Claude cohort is live
- **THEN** admission is refused

#### Scenario: Admitted-host client with no cohort for its platform

- **WHEN** a client on an admitted CIMD host authorizes while no cohort is live for its platform
- **THEN** admission is refused, regardless of any other platform's cohort

### Requirement: A single-platform cohort is promotable with evidence for that platform

Promotion SHALL accept exactly the platforms being promoted and require, for each, the same
clean-client evidence a paired promotion requires for it. Cross-client evidence equality
SHALL be enforced whenever two platforms are promoted together, and is inapplicable when
only one is.

#### Scenario: Single-platform promotion

- **WHEN** a candidate is promoted with a verified Claude artifact and Claude clean-client evidence
- **THEN** the candidate and that artifact become live
- **AND** the cohort is live for `claude` only

#### Scenario: Single-platform promotion with unverified evidence

- **WHEN** a single-platform promotion presents evidence that fails verification for that platform
- **THEN** the promotion is refused and nothing becomes live

#### Scenario: Paired promotion still cross-checks

- **WHEN** a candidate is promoted with artifacts for both platforms
- **THEN** the paired run, identity, and tenant evidence digests MUST name the same cohort
- **AND** a mismatch refuses the promotion

#### Scenario: Adding a second platform later

- **WHEN** a second platform is promoted against a candidate already live for one platform
- **THEN** the second artifact becomes live without retiring the first
- **AND** the cohort is thereafter live for both platforms
