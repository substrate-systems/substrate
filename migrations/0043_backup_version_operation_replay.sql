-- Migration 0043 — durable create-version operation replay
--
-- `backup_versions.client_operation_id` was intentionally scoped to live rows:
-- retention soft-deletes and GC hard-deletes old generations. That makes it
-- unsuitable as the idempotency record because a delayed replay could create
-- a second generation after the first was safely committed and pruned.

ALTER TABLE backup_versions
  ADD COLUMN IF NOT EXISTS replay_fence_token uuid,
  ADD COLUMN IF NOT EXISTS replay_fence_expires_at timestamptz;

CREATE TABLE IF NOT EXISTS backup_version_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backup_id uuid NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  operation_id text NOT NULL,
  -- Intentionally no FK: committed-operation tombstones outlive version GC.
  version_id uuid NOT NULL,
  manifest_size_bytes bigint NOT NULL,
  manifest_sha256 bytea NOT NULL,
  chunk_metadata jsonb NOT NULL,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (backup_id, operation_id)
);

CREATE INDEX IF NOT EXISTS backup_version_operations_owner_idx
  ON backup_version_operations (user_id, backup_id, operation_id);

-- Backfill every still-recorded operation, including retention-soft-deleted
-- rows. Re-running this statement preserves immutable payload bindings while
-- filling a previously unknown commit timestamp.
INSERT INTO backup_version_operations (
  user_id, backup_id, operation_id, version_id, manifest_size_bytes,
  manifest_sha256, chunk_metadata, committed_at
)
SELECT
  b.user_id,
  v.backup_id,
  v.client_operation_id,
  v.id,
  v.manifest_size_bytes,
  v.manifest_sha256,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'index', c.chunk_index,
      'encryptedSize', c.size_bytes,
      'sha256', encode(c.sha256, 'hex')
    ) ORDER BY c.chunk_index)
    FROM backup_chunks c
    WHERE c.version_id = v.id
  ), '[]'::jsonb),
  v.committed_at
FROM backup_versions v
JOIN backups b ON b.id = v.backup_id
WHERE v.client_operation_id IS NOT NULL
ON CONFLICT (backup_id, operation_id) DO UPDATE
SET committed_at = COALESCE(
  backup_version_operations.committed_at,
  EXCLUDED.committed_at
);

CREATE INDEX IF NOT EXISTS backup_versions_replay_fence_idx
  ON backup_versions (replay_fence_expires_at)
  WHERE replay_fence_expires_at IS NOT NULL;
