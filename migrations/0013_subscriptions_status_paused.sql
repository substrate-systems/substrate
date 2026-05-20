-- Migration 0013 — subscriptions.status allows 'paused'
-- Paddle's Billing API emits subscription.paused / subscription.resumed.
-- Paused subscribers retain read access (parallel to cancelled) but cannot
-- write new backups; the gate lives in src/lib/hosted-backup/auth-middleware.ts.

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('none', 'active', 'grace', 'paused', 'cancelled'));
