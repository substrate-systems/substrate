# Proposal

## Why

A responding server does not prove that sign-in emails or stored memory work. Public status needs recent functional evidence without exposing account data.

## What Changes

- Add fast public readers for recent control, email and memory proofs.
- Run protected scheduled checks against PostgreSQL, the email provider and one dedicated synthetic memory page.
- Preserve pod liveness and readiness semantics.
- Feed an external Upptime site at the approved status hostname.

## Capabilities

### New Capabilities

- `exomem-functional-health`: Persist and publish bounded, content-free functional health observations.

### Modified Capabilities

None. Existing admission, entitlement and gateway authorization contracts remain in force.

## Impact

The change adds a PostgreSQL migration, public routes, protected scheduler routes and a gateway proof reader and runner.
The external status repository consumes these routes. A separate platform release supplies schedules, synthetic credentials, networking and the public gateway rewrite.
The status site cannot replace missing health endpoints with unrelated server pings.
