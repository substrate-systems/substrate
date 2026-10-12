-- OAuth client slot reclaim (reclaim-oauth-client-slots).
--
-- Every partition of the client population bound counted every row it ever
-- admitted, so each one could only fill. Retirement gives a slot back without
-- deleting the row: which clients existed, and which carried reviewer
-- bootstrap history, stays checkable, and grants, tokens and evidence keep
-- the client they reference.

ALTER TABLE exomem_oauth_clients
  ADD COLUMN retired_at timestamptz;

-- A retired client takes no slot, so it must never be usable: enabling one
-- would admit a client the bound does not count. The first-party Home client
-- takes no slot and is never retired.
ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_retired_disabled
  CHECK (retired_at IS NULL OR (NOT enabled AND NOT first_party));

-- Every admission reads the partition count, and every sweep reads its
-- retirement candidates. Unretired rows stay at most the sum of the bounds
-- while retired rows accumulate, so both read this index instead of the table.
CREATE INDEX exomem_oauth_clients_unretired_partition_idx
  ON exomem_oauth_clients (admission_mode, auto_registered)
  WHERE retired_at IS NULL AND NOT first_party;

-- The retirement sweep looks up each candidate client's grants.
CREATE INDEX exomem_oauth_grants_client_idx
  ON exomem_oauth_grants (client_id);

-- The partitions, their bounds and their use, defined once. The admission
-- gates and the operator headroom report both read this function, so the
-- reported bound is the enforced bound. The three partition names are this
-- schema's own closed set. The bounds are migration 0062's, unchanged.
CREATE FUNCTION exomem_oauth_client_partitions()
RETURNS TABLE (client_partition text, bound integer, used integer)
LANGUAGE sql STABLE AS $$
  SELECT slots.client_partition, slots.bound,
         (
           SELECT count(*)::integer
           FROM exomem_oauth_clients AS client
           WHERE client.retired_at IS NULL
             AND NOT client.first_party
             AND CASE
                   WHEN client.admission_mode = 'generic' THEN 'generic'
                   WHEN client.auto_registered THEN 'auto_registered'
                   ELSE 'operator'
                 END = slots.client_partition
         )
  FROM (VALUES ('operator', 96), ('auto_registered', 128), ('generic', 128))
    AS slots (client_partition, bound)
$$;

COMMENT ON FUNCTION exomem_oauth_client_partitions() IS
  'Client population partitions: operator (96), auto_registered CIMD (128) and '
  'generic (128). Counts unretired clients only; first-party clients take no '
  'slot. The single definition of every partition, bound and count.';

-- An existing client keeps its own slot only while it holds one. A retired
-- client that returns needs a free slot like a new one: otherwise reviving
-- retired rows could push a partition past its bound.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partition_available(
  p_client_id text,
  p_auto_registered boolean
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM exomem_oauth_clients
      WHERE client_id = p_client_id AND retired_at IS NULL
    )
    OR (
      SELECT slots.used < slots.bound
      FROM exomem_oauth_client_partitions() AS slots
      WHERE slots.client_partition =
        CASE WHEN p_auto_registered THEN 'auto_registered' ELSE 'operator' END
    );
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Whether an operator or auto-registered CIMD client may take or keep a slot: '
  'it already holds one, or its partition in exomem_oauth_client_partitions has '
  'one free. A retired client holds none.';

CREATE OR REPLACE FUNCTION exomem_oauth_generic_client_partition_available()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT slots.used < slots.bound
  FROM exomem_oauth_client_partitions() AS slots
  WHERE slots.client_partition = 'generic';
$$;

COMMENT ON FUNCTION exomem_oauth_generic_client_partition_available() IS
  'Whether the generic partition in exomem_oauth_client_partitions has a free '
  'slot for a new dynamically registered client.';

-- Whether anything issued to a client can still be used, or is being issued
-- now: a grant that is not revoked, an unexpired code, access token or refresh
-- token, or an authorization in progress. Retirement is refused while this
-- holds, whatever the client's age. A grant that is not revoked counts even
-- without tokens: Home lists it as a connected app.
CREATE FUNCTION exomem_oauth_client_holds_live_authority(p_client uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM exomem_oauth_grants
      WHERE client_id = p_client AND revoked_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM exomem_oauth_authorization_codes
      WHERE client_id = p_client AND consumed_at IS NULL AND expires_at > now()
    )
    OR EXISTS (
      SELECT 1 FROM exomem_oauth_access_tokens
      WHERE client_id = p_client AND revoked_at IS NULL AND expires_at > now()
    )
    OR EXISTS (
      SELECT 1
      FROM exomem_oauth_token_families AS family
      JOIN exomem_oauth_refresh_tokens AS token ON token.family_id = family.id
      WHERE family.client_id = p_client
        AND family.revoked_at IS NULL AND family.expires_at > now()
        AND token.consumed_at IS NULL AND token.expires_at > now()
    )
    OR EXISTS (
      SELECT 1 FROM exomem_oauth_authorization_transactions
      WHERE client_id = p_client AND consumed_at IS NULL AND expires_at > now()
    );
$$;

COMMENT ON FUNCTION exomem_oauth_client_holds_live_authority(uuid) IS
  'True while a client holds a grant that is not revoked, an unexpired code, '
  'access token or refresh token, or an authorization in progress. Every '
  'retirement path refuses such a client.';
