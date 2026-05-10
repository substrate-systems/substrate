-- Migration 0011 — recovery_tokens_used
-- Hosted Backup v2.0 — append-only ledger of consumed recovery-token jtis,
-- so a successful finalize call invalidates the token and replays return
-- RECOVERY_TOKEN_EXPIRED. Contract §6 (recovery flow).
--
-- The PRIMARY KEY on jti is the atomic replay guard: a concurrent or
-- replayed finalize call collides on the unique constraint and is rejected.
-- recoverFinalizeAtomic in db.ts wraps this INSERT plus the credential
-- update in a single transaction so the burn is atomic with the rotation.
--
-- Row growth and GC: rows older than the recovery-token TTL
-- (RECOVERY_TOKEN_TTL_S = 600s) are no longer load-bearing — the JWT
-- signature check would fail on `exp` before we'd consult this table.
-- A periodic cleanup is therefore safe and cheap; the
-- recovery_tokens_used_used_at_idx index supports it without a full scan.
-- The cleanup itself is wired in a separate migration (or cron) as a
-- v2.0.x follow-up; it is not load-bearing for correctness.

CREATE TABLE recovery_tokens_used (
  jti uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recovery_tokens_used_user_idx
  ON recovery_tokens_used (user_id);

-- Supports a future GC sweep:
--   DELETE FROM recovery_tokens_used WHERE used_at < now() - interval '1 hour';
CREATE INDEX recovery_tokens_used_used_at_idx
  ON recovery_tokens_used (used_at);
