-- Migration 0038 — two-phase backup version commit (harden-cloud-generation-durability)
-- Contract: §7 (commit endpoint), §8 (versioning model).
--
-- Before this migration a `backup_versions` row became durable, listable and
-- restorable the instant `POST /api/backups/:id/versions` minted its presigned
-- URLs — before a single byte reached R2. A push that died mid-upload left a
-- phantom version that listed as a restore target, counted against quota, and
-- (because retention was enforced at create time) had already evicted a
-- genuinely good older version.
--
-- committed_at: set by `POST /api/backups/:id/versions/:vid/commit` once the
-- client has uploaded every chunk and the manifest. NULL means "the bytes are
-- not known to be there".
--
-- requires_commit: whether this row's visibility is gated on committed_at.
-- Negotiated per-request from the caller's `X-Endstate-API-Version` header, so
-- the rollout is backwards-compatible: a schema-2.0 engine has no commit call
-- and gets `false` (identical behaviour to before this migration), while a
-- 2.1+ engine gets `true` and opts into the gate. The visibility predicate is
-- therefore `(requires_commit = false OR committed_at IS NOT NULL)`.
--
-- The backfill is the load-bearing part of the compatibility story: every row
-- that already exists is stamped committed, so no existing subscriber's backup
-- history disappears when the visibility predicate ships.

ALTER TABLE backup_versions ADD COLUMN committed_at timestamptz;

ALTER TABLE backup_versions
  ADD COLUMN requires_commit boolean NOT NULL DEFAULT false;

-- Backfill: pre-existing versions predate the commit protocol and were, by
-- definition, the only versions the product ever showed. Stamp them committed
-- at their creation time so they stay visible under the new predicate.
UPDATE backup_versions SET committed_at = created_at WHERE committed_at IS NULL;

-- Drives the backup-gc pass that reclaims never-committed versions (and their
-- R2 objects) a few hours after mint. Partial index: the qualifying set is
-- tiny and short-lived, so the index stays near-empty in steady state.
CREATE INDEX backup_versions_uncommitted_idx
  ON backup_versions (created_at)
  WHERE requires_commit = true AND committed_at IS NULL AND deleted_at IS NULL;

-- Drives the version-visibility predicate used by list/quota/summary reads.
CREATE INDEX backup_versions_visible_idx
  ON backup_versions (backup_id, created_at DESC)
  WHERE deleted_at IS NULL AND (requires_commit = false OR committed_at IS NOT NULL);
