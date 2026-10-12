## Why

Hosted remains a friends-only v1 alpha. The shipped self-serve admission path can mint an anonymous invite whenever capacity is free, which opens the cohort before its intended review and operational gates are met.

This change defers the historical self-serve proposal archived at `openspec/changes/archive/2026-08-13-open-exomem-hosted-self-serve/`. Its public capacity admission, public paid offer, and new checkout requirements are not current alpha authority.

## What Changes

- **BREAKING** Defer public self-serve admission: anonymous visitors can register interest only and cannot mint an invite or reserve capacity.
- Keep authenticated operator-issued invitations and marketplace-reviewer bootstrap unchanged.
- Keep the existing self-serve schema and rows intact; public self-serve and v2 cohort admission remain deferred.
- Keep Paddle checkout disabled for this alpha.
- Retain existing billing reconciliation, webhooks, cancellation, and already-created subscription state without offering new checkout.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-access`: constrain anonymous alpha admission to interest registration and retain operator-only invitation creation.

## Impact

The public Hosted page and access request endpoint, access-route and marketplace-surface tests, operator runbook, and the access contract change. No migration, v1 fixture/catalog, or v2 cold-cut behavior changes.
