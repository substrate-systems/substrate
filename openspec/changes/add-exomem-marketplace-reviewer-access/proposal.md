## Why

Hosted Exomem already has production OAuth/MCP and invite-based user access, but marketplace reviewers need reusable credentials that work without access to a private email inbox, SMS, MFA, or network. Reusing a founder or friend account is neither reproducible nor safely revocable, so review access needs one narrow, explicit security boundary.

## What Changes

- Add operator-created marketplace reviewer credentials bound to one already-provisioned user and an immutable reviewer-purpose tenant with deterministic seeded review content.
- Store only credential digests, return generated plaintext once, and support expiry, rotation, revocation, durable rate limits, and generic authentication failures.
- Create only an ordinary Hosted browser session after successful reviewer authentication; never create or allocate a user, tenant, entitlement, cell, volume, or capacity reservation, and bind the credential provider to the active OAuth client's trusted platform.
- Continue the existing OAuth transaction after reviewer login so provider reviewers can install, authenticate, and exercise Exomem normally.
- Keep reviewer login disabled by default and separate from ordinary friend/private-alpha access.
- Add redacted operational checks and runbook steps for creating, seeding, rotating, sharing, and revoking provider review access.

## Capabilities

### New Capabilities

- `exomem-marketplace-reviewer-access`: Reusable, pre-bound, least-privilege reviewer authentication for Hosted Exomem marketplace review.

### Modified Capabilities

None.

## Impact

- Adds an additive database migration, a focused reviewer-access store/service, operator and public authentication routes, a small reviewer page, tests, and runbook updates.
- Reuses existing Hosted users, invitation provisioning, tenants, sessions, OAuth continuation, rate limiting, audit events, and revocation primitives while adding immutable reviewer-purpose and reviewer-credential attribution.
- Does not change ordinary invitation admission, public capacity, pricing, entitlements, provisioning, MCP tools, or the public-launch decision.
- Enables the reviewer-credential prerequisites in Exomem's provider packets and the unfinished clean-client acceptance tasks in `add-exomem-hosted-mcp-oauth`.
