## MODIFIED Requirements

### Requirement: Consumed reviewer bootstrap outcomes preserve exact sibling promotion lineage

After a reviewer OAuth bootstrap authority is consumed, the system SHALL permit internal-canary credentials only for the exact outcome tenant, candidate, assignment, and assignment generation. The selected staged client and OAuth client MAY be a fresh sibling of the bootstrap client only when they satisfy all ordinary stage/configuration/expiry fences and have no bootstrap-authority history. The bootstrap client SHALL remain disabled and unavailable for registration or credential issuance.

The system SHALL terminalize the consumed bootstrap stage, so a fresh same-platform sibling stage can be created without making the bootstrap stage reusable.

#### Scenario: Exact fresh Claude and OpenAI siblings receive paired credentials

- **WHEN** a consumed bootstrap outcome has an exact active assignment and two fresh configured sibling stages/clients, one for Claude and one for OpenAI
- **THEN** the system may issue one internal-canary credential for each platform under that exact assignment lineage
- **AND** each freshly registered sibling may remain disabled until its exact internal-canary credential authorizes the bounded pre-promotion run
- **AND** it does not reactivate, select, or register the consumed bootstrap client

#### Scenario: Bootstrap client or unrelated lineage is selected

- **WHEN** the selected client has bootstrap history, or the tenant, candidate, assignment, or generation differs from the consumed outcome
- **THEN** credential issuance fails closed
- **AND** no credential or OAuth session is created
