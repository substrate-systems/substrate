# exomem-tenant-control-plane Specification

## Purpose

Define authoritative tenant-to-cell mapping and durable, replay-safe provisioning, lifecycle, export, restore, and deletion orchestration.

## Requirements

### Requirement: Account-to-cell mapping is authoritative and unambiguous

The control plane SHALL hold at most one non-deleted Cloud cell row for each Exomem tenant, and the database SHALL refuse a second one. Tenant and cell identifiers MUST be opaque server-generated values and MUST NOT be selected by a public caller.

#### Scenario: Ready tenant resolves its cell

- **WHEN** an authenticated principal's tenant has one non-deleted cell row
- **THEN** the control plane resolves that exact cell and its desired state

#### Scenario: Mapping is absent or ambiguous

- **WHEN** a tenant has no non-deleted cell row, or a write would give it a second one
- **THEN** resolution fails closed with a stable content-free error, or the database refuses the write
- **AND** no historical, neighboring, or default cell is selected

### Requirement: Exomem deletion is complete, product scoped, and externally verified

Deleting Exomem SHALL require a fresh single-use owner confirmation. Confirmation SHALL revoke Exomem sessions and tokens, gate the entitlement and set the tenant's cell row to `deleted`. The tenant SHALL stay `deletion_pending` until its billing is cancelled and the tenant is scrubbed. Deletion MUST NOT delete shared identity or Endstate product data.

#### Scenario: Confirmed deletion completes

- **WHEN** an owner consumes a valid fresh deletion confirmation, and billing cancellation and the scrub succeed
- **THEN** the tenant becomes deleted, no Exomem route remains usable, and only a content-free receipt remains

#### Scenario: Storage destruction is still pending

- **WHEN** the cell row is `deleted` but billing cancellation or the scrub has not yet succeeded
- **THEN** the tenant stays `deletion_pending` and the periodic sweep retries
- **AND** Home and APIs do not claim deletion is complete

#### Scenario: User also has Endstate data

- **WHEN** that user deletes Exomem
- **THEN** their shared identity and Endstate credentials, subscriptions, and backups remain unchanged
