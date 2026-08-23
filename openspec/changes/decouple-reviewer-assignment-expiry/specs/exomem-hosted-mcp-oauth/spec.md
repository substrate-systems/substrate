## MODIFIED Requirements

### Requirement: One-shot reviewer OAuth bootstrap

The Hosted control plane SHALL allow an authenticated operator to create at
most one active reviewer OAuth bootstrap authority. The authority SHALL bind an
immutable delivered reviewer-purpose invite, pending `hosted-alpha-agent-v1`
0.39.2 candidate, exact staged release, and one pinned HTTP loopback client.

An unconsumed authority SHALL NOT be created with an expiry more than thirty minutes ahead,
so that an unspent bootstrap privilege is short-lived. The rollout assignment that
redemption creates SHALL take its expiry from the bound staged client release, and SHALL
NOT be further bounded by the authority that created it, which redemption consumes in the
same transaction. Every predicate that admits a reviewer canary, imports a client artifact,
or promotes a cohort SHALL continue to require the staged release to be unexpired
independently of the assignment.

#### Scenario: Bootstrap redemption succeeds

- **WHEN** the sole active authority's continuation and invite are redeemed
- **THEN** one transaction creates a nonlegacy reviewer tenant, entitlement,
  capacity reservation, preparing assignment, and fully snapshotted
  `initial-provision` operation
- **AND** creates a null-lineage setup session, grant, and non-exchangeable code
- **AND** consumes the invite, transaction, and authority while persisting the
  authority outcome IDs

#### Scenario: The evidence window outlives the authority that opened it

- **WHEN** an authority expiring in thirty minutes is redeemed against a staged release
  expiring later
- **THEN** the rollout assignment expires with the staged release, not with the authority
- **AND** the internal-canary credential issued against that assignment may live to the same
  bound, never beyond what the operator requested
- **AND** the canary may exchange, use and rotate tokens for the whole of that window

#### Scenario: The staged release still bounds the window

- **WHEN** the bound staged client release expires
- **THEN** the rollout assignment is expired no later than it
- **AND** canary token issue, read, MCP read and refresh rotation are all refused

#### Scenario: Existing usable authority blocks bootstrap

- **WHEN** a live cohort, active reviewer assignment, bound/ready reviewer
  cell, valid internal-canary credential, or active bootstrap exists
- **THEN** authority creation fails without enabling the selected client

#### Scenario: Bootstrap client is retired

- **WHEN** the authority is consumed, revoked, or expired
- **THEN** its client is disabled and versioned
- **AND** a client with bootstrap history cannot be normally enabled or repurposed
