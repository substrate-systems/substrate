-- Migration 0008 — subscriptions
-- Hosted Backup v2 (subscriptions). Contract: §10.
-- States and transitions are driven by Paddle webhook events. Internal
-- spelling 'cancelled' (two l's) per contract; Paddle's wire format uses
-- 'subscription.canceled' (one l). The mapping happens in applyPaddleEvent.

CREATE TABLE subscriptions (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  paddle_subscription_id text UNIQUE,
  paddle_customer_id text,
  status text NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'active', 'grace', 'cancelled')),
  grace_started_at timestamptz,
  cancel_started_at timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_paddle_customer_idx
  ON subscriptions (paddle_customer_id);
