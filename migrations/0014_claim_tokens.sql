-- Migration 0014 — claim_tokens
-- Hosted Backup anonymous-buyer linking. Stores single-use bearer tokens
-- that bind a pre-account users row (no auth_credentials) to a future
-- POST /api/auth/claim. Plaintext token lives in the email URL + GUI
-- paste-code only; server stores only sha256(token). Tokens expire after
-- 30 days. Cron at /api/cron/claim-followups resends at ~24h + ~7d and
-- alerts founder@ at 14 days unclaimed.

CREATE TABLE claim_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  resend_count smallint NOT NULL DEFAULT 0,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  founder_alerted_at timestamptz
);

-- Partial index: cron filters always include `consumed_at IS NULL`.
CREATE INDEX claim_tokens_user_id_idx
  ON claim_tokens (user_id) WHERE consumed_at IS NULL;
