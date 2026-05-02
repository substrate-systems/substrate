-- Migration 0010 — audit_log_account_deletions
-- Hosted Backup v2 (account deletion). Contract: §12.
-- user_id_hash is SHA-256(userId), not the raw UUID, so we retain "did this
-- user delete?" queryability without keeping identifying information.

CREATE TABLE audit_log_account_deletions (
  user_id_hash bytea NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL
);

CREATE INDEX audit_log_account_deletions_user_hash_idx
  ON audit_log_account_deletions (user_id_hash);
