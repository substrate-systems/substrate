-- Migration 0012 — subscriptions.plan
-- Adds a nullable `plan` column to record the Paddle price identifier the
-- user is subscribed to. Used by GET /api/account/me for debugging/display
-- and by support when correlating a user to their Paddle plan.

ALTER TABLE subscriptions ADD COLUMN plan text;
