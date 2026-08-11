## ADDED Requirements

### Requirement: One-shot reviewer OAuth bootstrap

The Hosted control plane SHALL allow an authenticated operator to create at
most one active reviewer OAuth bootstrap authority. The authority SHALL bind an
immutable delivered reviewer-purpose invite, pending `hosted-alpha-agent-v1`
0.39.2 candidate, exact staged release, and one pinned HTTP loopback client.

#### Scenario: Bootstrap redemption succeeds

- **WHEN** the sole active authority's continuation and invite are redeemed
- **THEN** one transaction creates a nonlegacy reviewer tenant, entitlement,
  capacity reservation, preparing assignment, and fully snapshotted
  `initial-provision` operation
- **AND** creates a null-lineage setup session, grant, and non-exchangeable code
- **AND** consumes the invite, transaction, and authority while persisting the
  authority outcome IDs

#### Scenario: Existing usable authority blocks bootstrap

- **WHEN** a live cohort, active reviewer assignment, bound/ready reviewer
  cell, valid internal-canary credential, or active bootstrap exists
- **THEN** authority creation fails without enabling the selected client

#### Scenario: Bootstrap client is retired

- **WHEN** the authority is consumed, revoked, or expired
- **THEN** its client is disabled and versioned
- **AND** a client with bootstrap history cannot be normally enabled or repurposed
