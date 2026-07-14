-- Migration 0023 — retry-safe Hosted Backup onboarding delivery.
--
-- Paddle event rows are processing leases, not just receipts. Claim rows are
-- keyed to the source Paddle event so an unsent initial email can be retried
-- without accumulating unusable token rows. Plaintext claim tokens are still
-- never persisted.

ALTER TABLE paddle_webhook_events
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_at timestamptz;

ALTER TABLE claim_tokens
  ADD COLUMN source_event_id text,
  ADD COLUMN initial_email_sent_at timestamptz,
  ADD COLUMN initial_email_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN initial_email_message_id text,
  ADD COLUMN last_email_error_code text;

ALTER TABLE subscriptions
  ADD COLUMN onboarding_source_event_id text,
  ADD COLUMN onboarding_email_kind text
    CHECK (onboarding_email_kind IN ('claim', 'fyi')),
  ADD COLUMN onboarding_processing_started_at timestamptz,
  ADD COLUMN onboarding_email_sent_at timestamptz,
  ADD COLUMN onboarding_email_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN onboarding_email_message_id text,
  ADD COLUMN onboarding_last_error_code text;

CREATE UNIQUE INDEX claim_tokens_source_event_id_idx
  ON claim_tokens (source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE UNIQUE INDEX claim_tokens_initial_onboarding_user_idx
  ON claim_tokens (user_id)
  WHERE source_event_id IS NOT NULL AND consumed_at IS NULL;
