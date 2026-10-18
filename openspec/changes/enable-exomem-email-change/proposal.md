## Why

An owner cannot move Exomem to another email address. The approved account dialog needs confirmation, cancellation and receipt delivery that work together.
The shared user table prevents an Exomem-only address change without affecting other products.

## What Changes

- Give Exomem a separate email identity while preserving existing identity, tenant, session and grant identifiers.
- Add owner-initiated email changes with confirmation at the new address and cancellation from the old inbox.
- Deliver the approved Home dialog and emails through the existing outbox.
- Synchronize the existing Paddle customer's receipt address with visible pending and permanent-conflict states.
- Release the compatible identity foundation before enabling changes, and retain that foundation as the rollback target.

## Capabilities

### New Capabilities

- `exomem-account-email`: confirmed account-address changes, cancellation and billing-contact synchronization.

### Modified Capabilities

- `exomem-hosted-access`: resolve Exomem identities independently of other products during invitation redemption and sign-in.

## Impact

The change affects Exomem identity reads, admission, database foreign keys, account routes, email delivery and the existing Paddle customer.
It reuses the current cryptographic helpers, outbox, database roles and provider transport. It adds no identity service or workflow framework.
The maintenance cost is one product identity table, pending email-change records and a bounded billing-contact projection.
