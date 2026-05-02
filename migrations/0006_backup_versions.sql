-- Migration 0006 — backup_versions
-- Hosted Backup v2 (storage). Contract: §7, §8.
-- Whole-snapshot versioning per contract §8 ("each POST creates a complete new copy").
-- 5-version retention enforced by application code; 7-day GC window via deleted_at.

CREATE TABLE backup_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id uuid NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  size_bytes bigint NOT NULL,
  manifest_object_key text NOT NULL,
  manifest_sha256 bytea NOT NULL,
  chunk_count int NOT NULL,
  deleted_at timestamptz
);

CREATE INDEX backup_versions_backup_deleted_created_idx
  ON backup_versions (backup_id, deleted_at, created_at DESC);
