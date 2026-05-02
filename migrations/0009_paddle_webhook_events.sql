-- Migration 0009 — paddle_webhook_events
-- Hosted Backup v2 (subscriptions). Idempotency table for Paddle webhooks.
-- Webhook handler INSERTs (event_id, event_type) ON CONFLICT DO NOTHING;
-- if rowCount is 0 the event is a duplicate and the handler returns 200 dedup.

CREATE TABLE paddle_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
