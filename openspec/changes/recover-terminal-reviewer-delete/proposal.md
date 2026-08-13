## Why

A reviewer tenant's provider DESTROY completed, but its old local finalizer hit bootstrap-lineage foreign keys and exhausted retries before the retention fix deployed. The exact delete is now terminal at the already-proven `destroyed` checkpoint, so normal scheduling cannot finish the control-plane cleanup.

## What Changes

- Add a content-free operator preflight for the one exact terminal reviewer delete shape.
- Add a one-shot, audited recovery that reopens only the local finalizer at its existing fence and `destroyed` checkpoint.
- Treat the persisted `destroyed` checkpoint as the provider proof and preserve the idempotency identity; recovery never calls the provider, creates a new delete, or edits capacity directly.
- Extend the Hosted runbook with the guarded replay and postconditions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-tenant-control-plane`: Permit one narrowly guarded replay of an already provider-proven terminal reviewer deletion so current finalizer code can finish tenant, cell, authority, and capacity cleanup.

## Impact

This changes the authenticated Hosted contracts operator route, its PostgreSQL control transaction, focused route/unit/integration tests, and the Hosted alpha recovery runbook. It adds no migration, public route, provider action, or generic terminal retry control.
