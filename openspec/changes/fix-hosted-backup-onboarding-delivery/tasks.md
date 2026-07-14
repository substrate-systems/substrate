## 1. Evidence and contract

- [x] 1.1 Identify the live customer, transaction, subscription, event stream,
      destination, delivery response, database state, and Brevo state.
- [x] 1.2 Amend OpenSpec before implementation.

## 2. Regression tests (red first)

- [x] 2.1 Real-shaped anonymous `subscription.activated` resolves email,
      creates/reuses a pre-account, and attempts the claim email.
- [x] 2.2 Anonymous `subscription.created` remains covered.
- [x] 2.3 Successful duplicate delivery is idempotent.
- [x] 2.4 Failed initial email returns non-2xx and the same event can succeed on
      retry without duplicate user/subscription/token rows.
- [x] 2.5 Customer lookup failure is actionable and retryable.
- [x] 2.6 Authenticated purchases preserve the current direct-correlation path.
- [x] 2.7 `transaction.completed` Supporter traffic does not enter Hosted
      Backup onboarding.

## 3. Implementation

- [x] 3.1 Add processing-lease/error fields to `paddle_webhook_events`.
- [x] 3.2 Add event-keyed initial-delivery fields to `claim_tokens` while
      retaining hash-only token storage.
- [x] 3.3 Implement atomic event claim/release/complete primitives.
- [x] 3.4 Make `subscription.created` and `subscription.activated` eligible for
      anonymous email fallback and retry re-entry.
- [x] 3.5 Make initial claim delivery event-idempotent and Brevo failure
      retryable.
- [x] 3.6 Read a dedicated Hosted Backup webhook secret with compatibility
      fallback; keep signature verification unchanged.

## 4. Verification and release

- [x] 4.1 Run focused webhook/subscription tests.
- [x] 4.2 Run full tests, lint/build, migration dry run, and strict OpenSpec
      validation.
- [x] 4.3 Run independent security/retry/idempotency review.
- [x] 4.4 Deploy through the normal production path and apply the migration.
- [x] 4.5 Create and verify the dedicated Paddle destination and production env.
- [x] 4.6 Replay/repair the original activation without another charge.
- [x] 4.7 Verify the onboarding email, claim flow, and active subscription.
