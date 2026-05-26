-- Migration 0015 — account_sessions + redeemed_browser_session_jtis
-- Hosted Backup /account portal handoff state. Backs the GUI → web
-- handoff documented in hosted-backup-contract.md §5 (the
-- POST /api/auth/browser-session pair) and the [[Endstate Account
-- Portal Architecture]] decision (2026-05-26).
--
-- account_sessions: opaque cookie-session for /account web users.
--   session_id is the cookie value (base64url, 32 random bytes).
--   1-hour Max-Age cookie; row TTL is the same. Sweeper purges expired
--   rows; consumers re-validate `expires_at > now()` on every request.
--
-- redeemed_browser_session_jtis: single-use ledger for the 60s URL
--   handoff JWT (aud=endstate-account). Burning the jti at redeem
--   prevents URL replay if the user copies the link out of the address
--   bar before the cookie swap. TTL is 5 min (JWT TTL + clock skew
--   margin); rows older than that are safe to GC.

CREATE TABLE account_sessions (
  session_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX account_sessions_user_id_idx ON account_sessions (user_id);
CREATE INDEX account_sessions_expires_at_idx ON account_sessions (expires_at);

CREATE TABLE redeemed_browser_session_jtis (
  jti uuid PRIMARY KEY,
  redeemed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX redeemed_browser_session_jtis_redeemed_at_idx
  ON redeemed_browser_session_jtis (redeemed_at);
