# Proposal

## Why

Cloud agents cannot send original file bytes through the gateway, so exact-byte Source capture cannot use the existing upload handoff.
The gateway needs a delegated-upload boundary that preserves the originating tenant, client, login generation and cell authorization.

## What Changes

- Reuse the cell's single-use upload ticket and held-file storage under the `capture-agent-files` contract.
- Sign a routing capsule and private origin proof with the existing gateway key machinery, using separate audiences.
- Add a fixed gateway `/upload` route that rechecks current OAuth authority before receiving bytes and streams only to the mapped cell.
- Preserve streaming limits, hash verification, one-use consumption and the later Source custody receipt.
- Keep issuance disabled until compatible sandbox cells pass the complete workflow; enable production through a separate live action.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-gateway`: authenticated upload routing and origin proof for the existing cell handoff.

## Impact

The gateway adds origin signing, delegated-origin lookup and streaming upload handling.
The cell adds verification, Cloud ticket wrapping and receiver reuse; its CLI accepts the additive Cloud envelope.
The existing HTTP, Ed25519, ticket and held-file primitives remain in use. No new database table or provider service is required.
