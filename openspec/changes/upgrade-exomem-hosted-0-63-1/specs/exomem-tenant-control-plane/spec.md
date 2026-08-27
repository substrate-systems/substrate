## ADDED Requirements

### Requirement: Hosted candidate authority includes immutable profile identity

The control plane SHALL treat profile identity as part of every hosted candidate, assignment, lifecycle target, routable observation, OAuth credential, reviewer result, and promotion decision. New private-alpha operations MUST target `hosted-alpha-agent-v4`; retained v1 catalog units MUST remain unchanged and MUST NOT satisfy v4 authority checks.

#### Scenario: Reviewer cell rolls forward to v4

- **WHEN** an operator authorizes a reviewer cell to roll forward to the checked 0.63.1/v4 candidate
- **THEN** the operation carries that candidate's release, profile, protocol, and digests through every checkpoint
- **AND** the v4 routable observation is recorded only after the same cell advertises the exact authorized tuple

#### Scenario: Legacy row cannot authorize v4

- **WHEN** a lifecycle, OAuth, review, or promotion query encounters a retained v1 candidate or observation
- **THEN** it does not use that row as authority for a v4 assignment or credential
- **AND** it leaves the legacy row unchanged

### Requirement: Promotion requires fresh paired evidence for the exact v4 candidate

The control plane SHALL promote the 0.63.1/v4 candidate only after fresh Claude and ChatGPT evidence proves authorization, discovery, recall, citation, durable capture, and fresh-session recall against the same tenant, candidate, assignment generation, and review window. Promotion MUST fail closed for stale evidence, mixed profiles, incomplete tool discovery, or evidence from an expired ceremony.

#### Scenario: Paired v4 review succeeds

- **WHEN** signed Claude and ChatGPT results in one active review window each prove the exact v4 candidate and its 25-tool discovery surface
- **THEN** the candidate is eligible for the existing one-shot promotion transaction
- **AND** promotion records v4 as the live private-alpha profile without rewriting v1 history

#### Scenario: Old 0.57.2 evidence is presented

- **WHEN** an operator presents otherwise valid evidence bound to the expired 0.57.2/v1 ceremony
- **THEN** the control plane rejects it as candidate or profile mismatched
- **AND** no live authority changes
