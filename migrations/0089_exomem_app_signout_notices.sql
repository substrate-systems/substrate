-- Migration 0089 — Exomem app sign-out notices.
--
-- An app can no longer reach its owner's cell once its grant holds no live
-- credential, but until now nothing said so: Home listed the grant while it
-- was unrevoked, and no email went out when Substrate ended the sign-in
-- itself (refresh replay, idle expiry, session ceiling, operator
-- revocation). This migration gives the readers of "ended" one definition,
-- the sweep a durable once-per-family marker, and the owner email its
-- outbox kind.

-- The runner applies this file in one transaction, and each table lock lasts
-- until it commits. A statement that waits for a lock blocks every request
-- queued behind it, so the migration fails after five seconds instead.
SET LOCAL lock_timeout = '5s';

-- A family can reach the cell while it holds a usable credential: an
-- unconsumed, unexpired refresh token, or — for a family issued without
-- refresh — an unrevoked, unexpired access token. The refresh token's
-- expires_at is the real idle window; the family's own expires_at is only
-- the session ceiling the tokens are already capped by, so a family whose
-- last refresh lapsed is dead even when the row reads unexpired. A spent
-- refresh token never counts: reuse inside its window is a code path, not
-- reachability. STABLE, not IMMUTABLE: it reads the token tables, so no
-- index can use it; the sweep's range scans drive from the token indexes
-- below instead.
CREATE FUNCTION exomem_oauth_family_live_until(family_id uuid)
RETURNS timestamptz
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM exomem_oauth_refresh_tokens AS token
      WHERE token.family_id = $1
    )
    THEN (
      SELECT max(token.expires_at)
      FROM exomem_oauth_refresh_tokens AS token
      WHERE token.family_id = $1 AND token.consumed_at IS NULL
    )
    ELSE (
      SELECT max(token.expires_at)
      FROM exomem_oauth_access_tokens AS token
      WHERE token.family_id = $1 AND token.revoked_at IS NULL
    )
  END
$$;

-- A family ends at the earlier of its revocation and the moment its last
-- usable credential expired: LEAST ignores a NULL side, and both NULL means
-- the family never held a credential and has no ending date to tell. Home's
-- per-grant reachability aggregate, the sign-out sweep and the send-time
-- recheck all take "ended" from these two functions, so they cannot drift.
CREATE FUNCTION exomem_oauth_family_ended_at(revoked_at timestamptz, live_until timestamptz)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT LEAST(revoked_at, live_until) $$;

-- One durable row per family ending the sweep decided to notify on. The
-- primary key makes the insert a once-per-family claim under retries and
-- concurrent sweeps; the row is written in the same transaction as the
-- email's enqueue, so a family is never emailed without its marker nor
-- marked without its email. emailed_at backs the per-grant 24-hour cap and
-- is always set for the rows this table holds: an ending the cap suppresses
-- gets no marker and is seen again once the cap lifts.
--
-- family_id is deliberately not a foreign key: the sweep deletes expired
-- families in the same run that notices them, and the marker is then the
-- only durable record of the ending — the email's send-time recheck reads
-- ended_at from here, and the cap must still see the emailed marker after
-- its family row is gone. grant_id cascades: a deleted grant's markers are
-- worth nothing.
CREATE TABLE exomem_oauth_app_signout_notices (
  family_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL REFERENCES exomem_oauth_grants(id) ON DELETE CASCADE,
  ended_at timestamptz NOT NULL,
  ended_reason text,
  emailed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The sweep's three drivers of "ended inside the lookback": a revocation
-- stamped on the family, the expiry of a family's last unconsumed refresh
-- token, and the expiry of a no-refresh family's last unrevoked access
-- token. Each range scan leads on its own column.
CREATE INDEX exomem_oauth_families_revoked_idx
  ON exomem_oauth_token_families (revoked_at)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX exomem_oauth_refresh_ended_idx
  ON exomem_oauth_refresh_tokens (expires_at)
  WHERE consumed_at IS NULL;

-- Per-family probes of the access-token side: a no-refresh family's
-- live_until, and the "is this the last" check inside the sweep's third
-- driver. The existing exomem_oauth_access_active_idx leads on expires_at
-- for the range scan itself.
CREATE INDEX exomem_oauth_access_family_active_idx
  ON exomem_oauth_access_tokens (family_id, expires_at)
  WHERE revoked_at IS NULL;

-- Home's per-grant aggregate reads every family of each listed grant
-- index-only on these columns, then probes each family's tokens through
-- exomem_oauth_refresh_active_idx (0025) and the index above.
CREATE INDEX exomem_oauth_families_grant_cover_idx
  ON exomem_oauth_token_families (grant_id, revoked_at, id);

-- The 24-hour cap reads only emailed markers for the grants being decided.
CREATE INDEX exomem_oauth_signout_notices_grant_idx
  ON exomem_oauth_app_signout_notices (grant_id, emailed_at);

-- Marker rows outlive their job once the cap and the send-time recheck can
-- no longer reach them; the sweep deletes the oldest per run.
CREATE INDEX exomem_oauth_signout_notices_emailed_idx
  ON exomem_oauth_app_signout_notices (emailed_at);

-- The new email kind joins the outbox's fixed set; the list repeats migration
-- 0086's, plus this one.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox ADD CONSTRAINT exomem_email_outbox_kind_check CHECK (
  kind IN ('start', 'place_opened', 'waitlist', 'hold_reminder', 'ready', 'payment_failed',
    'subscription_ended', 'deletion_reminder', 'deleted', 'invitation', 'friend_invitation', 'covered_invitation',
    'invitation_reminder', 'invitation_used', 'invitation_ended',
    'email_change_confirmation', 'email_change_cancellation',
    'invitation_waiting', 'waitlist_still_waiting', 'app_signout')
);
