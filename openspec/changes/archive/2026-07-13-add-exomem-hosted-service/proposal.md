## Why

Exomem already works as a strong personal knowledge system, but using it still assumes a technical owner can install, configure, and operate a vault-backed service. There is immediate demand from non-technical invitees, so Substrate needs to turn the existing single-vault runtime into an effortless hosted product without weakening Exomem's canonical-file ownership or tenant isolation.

## What Changes

- Add invite-only Exomem accounts and browser sessions with an email-link onboarding path that does not require GitHub, a CLI, or local installation.
- Add an authoritative account-to-tenant-to-cell registry, provider-neutral entitlements, lifecycle state, credential rotation, and idempotent provisioning orchestration.
- Add a public Exomem gateway that derives the destination cell exclusively from authenticated server-side identity, consumes Exomem's versioned registry contract, and forwards commands, retries, readiness, and transfers over a private authenticated channel.
- Add Exomem Home: a simple signed-in web surface for first capture, recall, recent memory, service state, export, billing, and account deletion.
- Reuse the existing Paddle adapter and webhook boundary for paid entitlements while supporting complimentary invite entitlements for the alpha. Paddle configuration and identifiers remain control-plane concerns and never enter vault content or cell request execution.
- Orchestrate verified export, restore, suspension, and deletion through Exomem's private cell lifecycle contract, with content-free audit records and external backup/KMS responsibilities remaining in Substrate.
- Keep Endstate Hosted Backup behavior and existing account flows compatible; Exomem product sessions, entitlements, and tenant resources are explicitly scoped.

## Capabilities

### New Capabilities

- `exomem-hosted-access`: Invite issuance and redemption, browser sessions, account ownership, CSRF-safe sign-out, and a five-minute invite-to-first-recall onboarding path.
- `exomem-tenant-control-plane`: Immutable account-to-cell mapping, isolated lifecycle state, secret handling, provisioning adapters, readiness, suspension, export/restore, and destructive deletion orchestration.
- `exomem-hosted-gateway`: Identity-derived command routing, Exomem contract negotiation, provider-neutral entitlement enforcement, scoped idempotency, private cell authentication, and tenant-bound transfers.
- `exomem-hosted-entitlements`: Complimentary alpha grants plus Paddle-backed catalog, checkout, webhook reconciliation, portal access, suspension, and provider-neutral capability projection.
- `exomem-home`: A non-technical signed-in product surface for onboarding, capture, recall, status, portability, subscription management, and account controls.

### Modified Capabilities

<!-- None. Existing Endstate Hosted Backup and public site specifications remain unchanged. -->

## Impact

- New Postgres migrations for Exomem invites, tenants/cells, sessions, entitlements, lifecycle operations, transfer grants, and content-free audit events.
- New server modules under `src/lib/exomem-hosted/` plus authenticated routes under `src/app/api/exomem/` and signed-in pages under `src/app/exomem/home/` and `src/app/exomem/invite/`.
- Reuse of the existing Paddle client, webhook verification, account identity tables, email provider, and deployment configuration with product-scoped adapters.
- Private connectivity from Substrate to isolated Exomem cells and an infrastructure adapter capable of provisioning one vault/state/log boundary per cell.
- Coordinated protocol/version fixtures with the Exomem repository; no Exomem cell runtime dependency on Paddle, browser sessions, or public tenant routing.
