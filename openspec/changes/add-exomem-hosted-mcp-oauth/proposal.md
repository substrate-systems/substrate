## Why

Exomem Hosted cannot deliver one-login plugin onboarding through the existing browser-only Home and private cell gateway. Claude and OpenAI clients need one public, standards-compatible MCP/OAuth boundary that turns a valid invite or entitlement into exactly one isolated tenant and then routes only the least-privilege Hosted agent profile.

## What Changes

- Add a shared public Streamable HTTP MCP endpoint with the discovery and OAuth metadata required by the supported Claude and OpenAI plugin clients.
- Make Substrate the Exomem OAuth issuer: authorize through the existing invite/magic-link identity flow, issue short-lived access tokens plus replay-safe rotating refresh tokens, and centrally enforce revocation, suspension, deletion, audience, client, and scope.
- Allow a successful first authorization to redeem a valid invite, establish the provider-neutral entitlement, reserve capacity, and enqueue exactly one idempotent tenant/cell provisioning operation without a separate Home setup flow.
- Serve pinned `hosted-alpha-agent-v1` tool discovery from the registered Exomem contract without waking or querying a tenant cell, including while the cell is provisioning.
- Route authenticated tool calls only to the caller's authoritative tenant and the profile-specific private Exomem agent path; never accept caller-selected tenant, cell, profile, vault, or private endpoint values.
- Return stable provisioning, capacity, entitlement, authorization, readiness, compatibility, and retry semantics without falling back to another tenant.
- Enforce alpha cost bounds: zero infrastructure on plugin installation alone, entitlement-gated allocation, capacity reservation before provider work, one logical cell/volume per tenant, bounded provision concurrency, request/response/rate/concurrency limits, 5 GiB usable storage, 90 MiB upload ceiling, and zero optional workers for the initial agent profile.
- Add cross-client live acceptance proving one-login onboarding, automatic content-bearing recall and capture from fresh chats, same-tenant attachment from another client, durable token continuity, and fail-closed revocation/isolation behavior.

## Capabilities

### New Capabilities

- `exomem-hosted-mcp-oauth`: Defines the public MCP transport, OAuth authorization and token lifecycle, invite-to-plugin onboarding, pinned agent discovery/routing, provisioning-aware errors, client continuity, and cross-client acceptance contract.

### Modified Capabilities

- `exomem-tenant-control-plane`: Adds atomic capacity reservation before first-login provisioning, concurrency-safe convergence from duplicate OAuth callbacks, and cost-aware suspension behavior while preserving tenant data according to policy.

## Impact

- Affected areas: Exomem access/identity flows, OAuth metadata and token persistence, MCP transport and session handling, registry-contract ingestion, gateway routing, entitlement admission, capacity accounting, tenant lifecycle reconciliation, rate limiting, operational telemetry, and end-to-end tests.
- External dependency: the paired Exomem change `add-hosted-client-plugins` publishes the client packages and Hosted-safe skills; `add-hosted-agent-surface-profile` supplies the immutable `hosted-alpha-agent-v1` private contract and route.
- Infrastructure remains the existing shared Hosted cluster with isolated tenant processes and volumes; this change does not create infrastructure at plugin install time or introduce per-client cells.
- Existing Exomem Home browser sessions, command routes, billing projection, private cell credentials, and non-Exomem Substrate products remain compatible.
