-- Migration 0007 — backup_chunks
-- Hosted Backup v2 (storage). Contract: §3, §7.
-- Tracks per-chunk metadata for integrity checks. The server never reads
-- chunk contents — chunks are stored in R2 and accessed via presigned URLs.

CREATE TABLE backup_chunks (
  version_id uuid NOT NULL REFERENCES backup_versions(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  object_key text NOT NULL,
  size_bytes int NOT NULL,
  sha256 bytea NOT NULL,
  PRIMARY KEY (version_id, chunk_index)
);
