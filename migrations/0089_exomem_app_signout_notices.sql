-- Migration 0089 — Exomem app sign-out notices.
--
-- An app can no longer reach its owner's cell once every token family under
-- its grant has ended, but until now nothing said so: Home listed the grant
-- while it was unrevoked, and no email went out when Substrate ended the
-- sign-in itself (refresh replay, idle expiry, session ceiling, operator
-- revocation). This migration gives the three readers of "ended" one
-- definition, the sweep a durable once-per-family marker, and the owner
-- email its outbox kind.

-- A token family ends at the earlier of its revocation and its expiry. Home's
-- per-grant reachability aggregate, the sign-out sweep's detection range scan
-- and the index that serves it all use this function, so the three cannot
-- drift. IMMUTABLE: no clock reads, so the index below may use it.
CREATE FUNCTION exomem_oauth_family_ended_at(revoked_at timestamptz, expires_at timestamptz)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT LEAST(expires_at, COALESCE(revoked_at, expires_at)) $$;

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

-- The sweep's range scan over families that ended since its lookback horizon.
CREATE INDEX exomem_oauth_families_ended_idx
  ON exomem_oauth_token_families ((exomem_oauth_family_ended_at(revoked_at, expires_at)));

-- Home's per-grant aggregate reads every family of each listed grant
-- index-only: the live check and the latest ended-at both come from these
-- three columns.
CREATE INDEX exomem_oauth_families_grant_cover_idx
  ON exomem_oauth_token_families (grant_id, expires_at, revoked_at);

-- The 24-hour cap reads only emailed markers for the grants being decided.
CREATE INDEX exomem_oauth_signout_notices_grant_idx
  ON exomem_oauth_app_signout_notices (grant_id, emailed_at);

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
