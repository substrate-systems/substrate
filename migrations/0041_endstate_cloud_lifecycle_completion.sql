-- Migration 0041 — durable lifecycle transitions and cancellation retries.
--
-- A missed final Paddle event must not extend Cloud retention forever. The
-- cron atomically advances expired grace rows using the deterministic grace
-- deadline, then applies the ordinary cancellation-retention purge.

ALTER TABLE paddle_cancellation_tombstones
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN attention_required_at timestamptz;

CREATE INDEX paddle_cancellation_tombstones_pending_idx
  ON paddle_cancellation_tombstones (next_attempt_at, created_at)
  WHERE cancelled_at IS NULL;
