-- OpenSpec change keep-apps-signed-in-across-parallel-sessions.
--
-- The refresh rotation grants a spent token's own client a fresh pair while
-- the spend is younger than the reuse interval and refuses it as stale past
-- the interval, both measured against one boundary timestamp per statement.
-- The CIMD metadata-state read shares that boundary: a refresh refused only
-- because a connector's metadata lapsed is worth a refetch whether the token
-- is unconsumed or spent inside the interval. Without this, one expired
-- metadata document on a shared auto-registered client turns a same-client
-- reuse into an invalid_grant that clears every parallel session's store.
-- One function is the boundary's only definition.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION exomem_oauth_refresh_reuse_opens_at(p_interval_seconds integer)
RETURNS timestamptz
LANGUAGE sql
AS $$
  SELECT clock_timestamp() - (p_interval_seconds * interval '1 second')
$$;
