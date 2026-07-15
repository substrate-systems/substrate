# Scheduled cancellation state

## Problem

Paddle reports an end-of-period cancellation as an active subscription with a
`scheduled_change`. The webhook mapper previously discarded that field and
used `next_billed_at` as the period end. Paddle clears `next_billed_at` after a
cancellation is scheduled, leaving the account portal with an ambiguous Active
card and no date.

## Design

- Keep `status = active` until Paddle emits the final canceled state so backup
  entitlement does not change early.
- Persist `scheduled_change.effective_at` as `subscriptions.scheduled_cancel_at`
  only when the action is `cancel`; clear it on later events without a cancel
  change.
- Derive `current_period_end` from `current_billing_period.ends_at`, falling
  back to `next_billed_at` for older payloads.
- Expose the scheduled cancellation through the entitlement, account API, and
  server-rendered account snapshot.
- Render an amber `Cancelling` state with
  `Access remains active through <date>.` The Paddle management action remains
  available.

## Verification

Focused tests cover Paddle mapping, scheduled-change clearing, UI copy and
tone, and the migration/database persistence contract. Type checking and the
full repository test suite remain the release gates.
