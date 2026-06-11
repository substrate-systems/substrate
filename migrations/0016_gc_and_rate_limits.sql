-- Migration 0016 — GC + rate limiting (harden-hosted-backup-operations)
--
-- r2_purge_queue: durable queue of R2 prefixes to purge. Hard deletes
-- (backups, accounts) enqueue here in the same statement as the DELETE,
-- because the deleted rows carried the only object-key knowledge. Drained
-- by the daily backup-gc cron; purged_at is set only once the prefix lists
-- empty in R2.
-- attempts/last_attempt_at/last_error: failure bookkeeping so a poison
-- prefix (persistent R2 error) rotates to the back of the queue instead of
-- head-of-line-blocking newer purges, and dead-letters after a cap (the cron
-- selects attempts < cap). last_attempt_at stays NULL while a large prefix
-- is still being drained within budget, keeping it at the front until done.
CREATE TABLE r2_purge_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  r2_prefix text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  purged_at timestamptz
);

CREATE INDEX r2_purge_queue_pending_idx
  ON r2_purge_queue (last_attempt_at, enqueued_at)
  WHERE purged_at IS NULL;

-- rate_limit_events: sliding-window counters for credential endpoints
-- (login/recover record failures; signup records attempts). Rows older than
-- 24h are pruned by backup-gc; windows in use are <= 1h.
CREATE TABLE rate_limit_events (
  scope text NOT NULL,
  key text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rate_limit_events_scope_key_at_idx
  ON rate_limit_events (scope, key, at);

-- manifest_seen_at: GC bookkeeping for the abandoned-upload sweep. NULL =
-- the manifest object has not yet been confirmed present in R2; the cron
-- HEADs such versions once they are >48h old, stamps this on 200, and
-- soft-deletes on 404 (presigned PUT URLs live 5 minutes, so an absent
-- manifest at that age can never appear later).
ALTER TABLE backup_versions ADD COLUMN manifest_seen_at timestamptz;

CREATE INDEX backup_versions_manifest_unseen_idx
  ON backup_versions (created_at)
  WHERE deleted_at IS NULL AND manifest_seen_at IS NULL;
