## Why

Customer access currently depends on certification of a distributed client artifact, while certifying that artifact requires working customer access. Separate those decisions and remove avoidable network work so the hosted alpha can launch on one durable service path.

## What Changes

- Activate a signed, runtime-compatible candidate independently of client artifact certification; certify clients against that already-active runtime.
- Authorize eligible owners and approved clients without an artifact-cohort predicate at any OAuth stage. Preserve consent, PKCE, exact audience, revocation, entitlement, capacity and tenant isolation.
- Deploy the existing canonical MCP handler as a small shared gateway beside the tenant cells, keeping accounts, OAuth, billing and provisioning in the control plane and keeping the public resource URL unchanged.
- Keep current policy authoritative on each request; cache only immutable contract parsing and validators. Replace the extra private contract GET only when the cell enforces the expected contract on the command itself.
- Make client continuity, meaningful recall and measured latency release acceptance checks. Marketplace publication remains separately certified.

## Capabilities

### New Capabilities

- `exomem-hosted-service-admission`: Independent runtime activation, service authorization and client certification, including their migration and failure behavior.

### Modified Capabilities

- `exomem-hosted-gateway`: Deployment-independent public MCP behavior, fresh authorization and bounded private command forwarding.

## Impact

Touches the hosted OAuth and contract stores, candidate promotion, lifecycle target selection, canonical MCP/gateway handler, a standalone gateway entrypoint and its image, database migrations, tests and operational runbooks. The companion Exomem change with this same name owns the private command binding, cluster/edge deployment and end-to-end launch evidence. No production behavior changes in this planning PR.

This change supersedes the artifact-as-service-admission portions of `scope-cohort-admission-per-platform` and `add-exomem-hosted-mcp-oauth`; it does not discard their client security or certification contracts. Generic arbitrary client registration from `admit-generic-mcp-clients` remains outside scope.
