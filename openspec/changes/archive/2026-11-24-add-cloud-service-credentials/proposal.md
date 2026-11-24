## Why

A backend product that serves a creator needs to reach that creator's Exomem Cloud cell without a person in the loop. The Cloud gateway admits only OAuth access tokens, which live 15 minutes and are renewed through an interactive login and consent. A product backend has no browser and stores one secret per cell. No Cloud credential exists for it today, so a creator's product data cannot live on Exomem Cloud.

The product also reads the cell's discovery document (`/.well-known/exomem-cell`) before each connection to check that the address still serves the registered cell. The gateway answers that path with 404, because one gateway host fronts every cell and it can choose a cell only from an authenticated principal.

## What Changes

- Add tenant-scoped **service credentials**. An operator issues one for a tenant and a named product principal (`service:<product>`). The control plane stores only the credential's digest. A tenant may hold at most two live credentials for one principal, so a product can rotate without downtime. The operator revokes a credential by id, and the gateway refuses it on the next request.
- The gateway accepts a service credential on the MCP path, as it accepts an access token. It routes only to the tenant's cell, derives the cell bearer and signs the origin proof as for an access token. The proof names the product principal as its client, so a later cell change can tell the product apart from the owner's own agents without a gateway change.
- The gateway forwards an authenticated `GET /.well-known/exomem-cell` to the caller's cell and returns the cell's bytes unchanged. An unauthenticated request still receives 401 and reaches no cell.
- Add operator routes to issue, list and revoke service credentials, guarded by the existing admin token. The issue response is the only place the secret appears.

## Capabilities

### New Capabilities

- `exomem-cloud-service-credentials`: issuance, storage, rotation and revocation of tenant-scoped product credentials, and how the Cloud gateway admits them and forwards cell discovery.

### Modified Capabilities

None. The pending `adopt-exomem-cloud-plain-cells` delta keeps its authenticated pass-through requirement; this change adds a second credential kind that the same pass-through admits.

## Impact

- One additive migration with a new table. No existing table changes.
- The Cloud gateway: a credential-kind dispatch before the token lookup, and one new GET route.
- New operator admin routes and a runbook section.
- No change to OAuth, consent, sessions, billing or cell provisioning.
- On the cell, a service credential has the same authority as the owner's cell bearer has today. Separating the product principal inside the cell is Exomem's later service-principal stage. Until then, the operator issues service credentials only for cells whose owner allows that product full access.
- A new gateway image release and a platform chart update ship it. Both are existing release paths.
