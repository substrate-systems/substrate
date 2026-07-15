-- Migration 0024 - scheduled subscription cancellation.
-- Paddle keeps a subscription active until a scheduled cancellation takes
-- effect. Store that date separately from the current entitlement status.

ALTER TABLE subscriptions
  ADD COLUMN scheduled_cancel_at timestamptz;
