-- Migration 0005 — backups
-- Hosted Backup v2 (storage + subscriptions). Contract: ../hosted-backup-contract.md §7, §8.

CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX backups_user_deleted_idx ON backups (user_id, deleted_at);
