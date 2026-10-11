## Why

Exomem Hosted is retired and every tenant runs on Exomem Cloud. The Hosted provisioning, lifecycle, restore, export, command-contract and transfer code is removed from Substrate. The canonical requirements that describe it must go with it, so the specs describe only what Substrate runs.

## What Changes

- The v1 provisioning, lifecycle, restore, export, observability and recovery requirements leave `exomem-tenant-control-plane`.
- The tenant-to-cell mapping and the product-scoped deletion requirements are rewritten for Cloud cell rows.
- The contract-derived command and transfer-grant requirements leave `exomem-hosted-gateway`.
- The gateway's routing, forwarding, entitlement, idempotency, retry, logging and isolation requirements stay. A later change rewrites them for the Cloud pass-through, which `adopt-exomem-cloud-plain-cells` defines.

## Capabilities

### Modified Capabilities

- `exomem-tenant-control-plane`: Hosted lifecycle requirements are removed; mapping and deletion describe Cloud cell rows.
- `exomem-hosted-gateway`: the command-contract and transfer-grant requirements are removed.

## Impact

- Delivered with the code retirement of `adopt-exomem-cloud-plain-cells` tasks 5.1 and 5.2.
- No migration changes. The legacy tables stay until a later migration drops them.
