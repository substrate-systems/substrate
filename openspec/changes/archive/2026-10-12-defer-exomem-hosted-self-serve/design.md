## Context

Migration `0038_exomem_self_serve_admission.sql` and its data are already applied. Reversing or editing it would rewrite history and does not remove the public admission authority.

## Decision

Leave the legacy self-serve storage and implementation intact, but make `POST /api/exomem/access/request` fail closed with HTTP 410 before parsing input, invoking admission, creating an invite, or consulting capacity. Route the public Hosted form solely to the existing `POST /api/exomem/interest` capture endpoint. Operator invitations and reviewer bootstrap continue through their authenticated paths.

Do not offer a new checkout from the owner billing summary or Home. Make an empty `POST /api/exomem/billing/checkout` fail closed before the billing service can create a transaction. Keep the transaction-bound return path, webhook reconciliation, portal, cancellation, and existing subscription state available for prior arrangements.

## Deferred work

Public self-serve admission, public paid offers, new payment checkout, and v2/cold-cut cohort activation require a future, explicit OpenSpec change. The historical proposal is archived at `openspec/changes/archive/2026-08-13-open-exomem-hosted-self-serve/` without syncing its deltas; this alpha does not alter Paddle reconciliation, fixtures/catalogs, or existing migration rows.

## Verification

Route tests prove a free-capacity anonymous request cannot reach the admission boundary or begin a new checkout. Public-surface tests prove the form only calls interest capture and Home does not advertise checkout. Existing operator-invite and reviewer tests remain green.
