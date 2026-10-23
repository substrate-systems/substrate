## Why

Cloud clients need a tenant-owned request channel for encrypted imports before controller and browser consumers can ship. C5 records that shared interface and its split authority.

## What Changes

- Add content-free import requests, immutable upload reports, and controller transport observations.
- Expose tenant-bound import creation, status, completion, cancellation, and discard endpoints.
- Admit the ordinary pinned CLI OAuth client with a loopback callback.
- Extend the cell hold protocol with `import`.
- Complete the Home browser flow for encrypted folder upload, exact multipart retries, status, cancellation, and discard.
- Distinguish loose-document adoption from migration of an existing managed vault. Adoption does not preserve active identities or history.

## Capabilities

### New Capabilities

### Modified Capabilities

- `exomem-tenant-control-plane`: Add the C5 import contract and authenticated client operations.

## Impact

The migration, Cloud grants, OAuth admission, Next API handlers, and Home flow change. The schema and API deploy before cellctl consumers. No import bytes or private keys pass through Substrate's servers.
