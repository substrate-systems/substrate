-- OpenSpec change admit-standard-mcp-clients.
--
-- (1) One admission rule. The pinned/generic/CIMD admission predicate was
-- inlined, a little differently nested, into nine SQL sites spanning client
-- resolution, the authorization transaction, consent, owner attachment,
-- invite admission, token exchange, refresh, the gateway's token lookup and
-- the reviewer login. exomem_oauth_client_admitted() is now the one rule; the
-- sites pass their row's columns and keep every other condition they had.
-- p_allow_uncertified splits the sites that may admit self-declared clients
-- (the generic DCR lane and lane-admitted unlisted-host CIMD clients) from
-- the marketplace reviewer login, which still admits certified clients only.
--
-- (2) Open CIMD under the generic lane. A CIMD client is admitted when its
-- host is allowlisted OR the lane is enabled. An unlisted host registers with
-- no platform, so the row is auto_registered with a NULL platform; the
-- partitions view now counts that shape in the generic partition and a new
-- availability function lets the register path ask for a slot by name.
--
-- (3) Stored client context. client_context records the engagement context at
-- registration (loopback redirects are coding agents, everything else a
-- conversational app); the gateway and the apps list read it instead of
-- re-deriving, and the owner can change it on Home.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION exomem_oauth_client_admitted(
  p_admission_mode text,
  p_enabled boolean,
  p_metadata_document_digest bytea,
  p_metadata_fetched_at timestamptz,
  p_metadata_ttl_seconds integer,
  p_metadata_expires_at timestamptz,
  p_cimd_host text,
  p_client_platform text,
  p_allow_uncertified boolean,
  p_as_of timestamptz
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT p_enabled
    AND (
      p_admission_mode = 'pinned'
      OR (p_allow_uncertified AND exomem_oauth_generic_client_admitted(p_admission_mode))
      OR (
        p_metadata_document_digest IS NOT NULL
        AND p_metadata_fetched_at IS NOT NULL
        AND p_metadata_ttl_seconds BETWEEN 300 AND 604800
        AND p_metadata_expires_at > p_as_of
        AND p_cimd_host IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
            WHERE admitted.host = p_cimd_host AND admitted.platform = p_client_platform
          )
          OR (p_allow_uncertified AND exomem_oauth_generic_client_admitted('generic'))
        )
      )
    );
$$;

-- The generic partition takes uncertified CIMD clients too. An auto-registered
-- row with no platform is a CIMD client only the lane admits, so it draws on
-- the same bound as DCR clients rather than the allowlisted-CIMD bound.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partitions()
RETURNS TABLE (client_partition text, bound integer, used integer)
LANGUAGE sql STABLE AS $$
  SELECT bounds.client_partition, bounds.bound,
         (
           SELECT count(*)::integer
           FROM exomem_oauth_clients AS client
           WHERE client.retired_at IS NULL
             AND client.admission_mode <> 'first_party'
             AND CASE
                   WHEN client.admission_mode = 'generic' THEN 'generic'
                   WHEN client.auto_registered AND client.client_platform IS NULL THEN 'generic'
                   WHEN client.auto_registered THEN 'auto_registered'
                   ELSE 'operator'
                 END = bounds.client_partition
         )
  FROM exomem_oauth_client_partition_bounds AS bounds
$$;

-- Whether p_client_id may take a slot in p_partition: a free slot, or the row
-- already holds one (present and unretired, so reviving it asks for no new
-- slot). Lets the CIMD register path check the generic partition for an
-- unlisted host and the auto_registered partition for an allowlisted one.
CREATE FUNCTION exomem_oauth_client_partition_available_for(
  p_client_id text,
  p_partition text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
      SELECT 1
      FROM exomem_oauth_clients
      WHERE client_id = p_client_id
        AND retired_at IS NULL
    )
    OR COALESCE((
      SELECT slots.used < slots.bound
      FROM exomem_oauth_client_partitions() AS slots
      WHERE slots.client_partition = p_partition
    ), false);
$$;

-- The stored context: coding when every registered redirect is loopback (the
-- app receives its codes on the owner's own machine), conversation otherwise.
-- The rule mirrors isLocalOAuthClient; registration sets it in code, and this
-- backfill applies it to the rows that already exist.
ALTER TABLE exomem_oauth_clients ADD COLUMN client_context text;

UPDATE exomem_oauth_clients
SET client_context = CASE
  WHEN NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(redirect_uris) AS uri
    WHERE uri !~* '^https?://([^@/?#]+@)?(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?([/?#].*)?$'
  ) THEN 'coding'
  ELSE 'conversation'
END;

ALTER TABLE exomem_oauth_clients
  ALTER COLUMN client_context SET NOT NULL,
  ADD CONSTRAINT exomem_oauth_clients_client_context_valid
    CHECK (client_context IN ('coding', 'conversation'));
