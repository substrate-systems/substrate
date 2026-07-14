## Why

A real Endstate Hosted Backup monthly purchase completed in Paddle on
2026-07-14, but no onboarding email was sent. Production evidence shows two
independent launch blockers:

1. Paddle had no notification destination for
   `https://substratesystems.io/api/webhooks/paddle`; the only live destination
   sent `transaction.completed` to the legacy license webhook.
2. Paddle emitted `subscription.activated`, not `subscription.created`, for the
   first active-subscription event. The anonymous-buyer email fallback currently
   runs only for `subscription.created`.

The current handler also records an event before all required side effects,
then treats any repeated `event_id` as complete. Customer lookup and Brevo
failures are swallowed and return 200. A transient failure can therefore strand
a paid customer permanently.

## What Changes

- Treat both `subscription.created` and the first anonymous
  `subscription.activated` event as eligible to bootstrap a pre-account.
- Replace receipt-only deduplication with an atomic processing lease that
  distinguishes processed, in-progress, and retryable events.
- Mark the Paddle event processed only after the required onboarding/FYI email
  has been accepted by Brevo.
- Persist onboarding delivery state on the Paddle subscription and claim state
  on the source event. A failed initial send is retryable without duplicate
  users, subscriptions, claim-token rows, or created/activated emails.
  Plaintext claim tokens remain memory/email-only; only hashes are stored.
- Fence event completion/release by processing attempt so a stale worker cannot
  complete a newer attempt.
- Classify subscription events against the configured Hosted Backup price IDs
  before mutating Hosted Backup state.
- Return an actionable non-2xx response for customer lookup, unknown-user, or
  email-delivery failures so Paddle retries.
- Use a dedicated `PADDLE_HOSTED_BACKUP_WEBHOOK_SECRET` (with the existing
  secret as a compatibility fallback) for the dedicated Hosted Backup
  destination. The Supporter/license destination remains separate.
- Configure the live Hosted Backup destination for the subscription lifecycle
  and repair the existing purchase without a second charge.

## Capabilities

### Modified Capabilities

- `hosted-backup-subscriptions`: real first-event handling, retry-safe event
  processing, and required anonymous-buyer onboarding delivery.
- `hosted-backup-claim-flow`: event-keyed initial delivery state while
  preserving hash-only token storage.

## Impact

- One additive migration for Paddle processing and claim delivery state.
- Focused changes to the Hosted Backup Paddle route, subscription resolver,
  claim-token primitives, and their tests.
- One new production environment variable and one new Paddle notification
  destination.
- No changes to backup encryption/storage, the claim consumption protocol, or
  the Supporter/license webhook path.
