## MODIFIED Requirements

### Requirement: Exomem Home reflects service state honestly

The signed-in Home surface SHALL render one of awaiting-payment, preparing, ready,
degraded, suspended, export-in-progress, deletion-pending, or deleted states from
authoritative control-plane data. It MUST NOT display a ready capture surface before
the mapped cell passes private readiness. Awaiting-payment MUST be derived only from
a private-alpha entitlement that is awaiting checkout or checkout pending, a
reserved allocation, and the absence of its initial provisioning operation.

#### Scenario: Tenant is awaiting payment

- **WHEN** the owner has redeemed a paid private-alpha invite but has no authoritative active or trialing subscription
- **THEN** Home shows the fixed €5 monthly private-alpha offer and one Subscribe and prepare Exomem action
- **AND** it does not poll provisioning readiness or imply that provider resources exist

#### Scenario: Tenant is provisioning

- **WHEN** the owner's paid subscription or complimentary grant has released an initial operation and the cell is not yet ready
- **THEN** Home shows plain-language deterministic progress, polls a content-free status route, and exposes a request reference for support

#### Scenario: Tenant is ready

- **WHEN** the mapping, entitlement, protocol, and private readiness all permit service
- **THEN** Home presents capture and recall as the primary actions

#### Scenario: Tenant is suspended

- **WHEN** manual or entitlement suspension is active
- **THEN** Home prevents new writes, explains the available recovery and account actions, and never attempts to route around suspension
