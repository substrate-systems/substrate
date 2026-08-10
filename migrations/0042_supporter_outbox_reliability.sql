-- Migration 0042 — supporter delivery retries are durable and observable.
-- Keep only the contribution contact needed for the acknowledgement; failed
-- delivery remains retryable indefinitely and escalates operationally.

ALTER TABLE supporter_email_outbox
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attention_required_at timestamptz;

CREATE INDEX supporter_email_outbox_pending_idx
  ON supporter_email_outbox (next_attempt_at, created_at)
  WHERE sent_at IS NULL;
