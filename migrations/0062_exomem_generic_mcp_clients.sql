-- Generic MCP clients (admit-generic-mcp-clients).
--
-- A generic client is one that no marketplace distributes: Codex CLI, Zed, a
-- hand-written agent. It registers itself through RFC 7591 dynamic client
-- registration and carries no platform, no configuration digest and no
-- metadata host. Who may reach a tenant is still decided only by an invite or
-- an existing ownership; this lane changes which software may ask.
--
-- The lane ships disabled. One UPDATE of exomem_oauth_generic_client_lane
-- enables or withdraws it at every admission stage at once.

-- 1. A third admission mode. The modes are this schema's own closed set.
ALTER TABLE exomem_oauth_clients
  DROP CONSTRAINT exomem_oauth_clients_admission_mode_check;
ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_admission_mode_check
  CHECK (admission_mode IN ('pinned', 'cimd', 'generic'));

-- 2. The name a client gives itself, for the consent page and Home. The
-- registration paths sanitise and bound it before they store it. It is
-- self-asserted, so it proves nothing about which software the client is.
-- NULL when the client declared no readable name; a reader names such a
-- client from its platform or host.
ALTER TABLE exomem_oauth_clients
  ADD COLUMN client_name text;
ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_client_name_valid
  CHECK (client_name IS NULL OR char_length(client_name) BETWEEN 1 AND 64);

-- 3. The shape of a generic client. No platform and no configuration digest:
-- certified admission keys on both, so a generic row can never satisfy a
-- certified arm. No metadata host. Never in the CIMD self-registration
-- provenance, so that path's upsert can never rewrite a generic row.
ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_generic_shape
  CHECK (
    admission_mode <> 'generic' OR (
      client_platform IS NULL
      AND oauth_client_config_sha256 IS NULL
      AND cimd_host IS NULL
      AND auto_registered = false
    )
  );

-- 4. Authoritative lane state. One row, disabled. A missing row reads as
-- disabled, so deleting it also withdraws the lane.
CREATE TABLE exomem_oauth_generic_client_lane (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO exomem_oauth_generic_client_lane (singleton, enabled)
VALUES (true, false)
ON CONFLICT DO NOTHING;

-- 5. The generic admission arm, defined once. Every admission predicate calls
-- it with the client's admission mode and nothing else, so the arm cannot
-- consult a platform, a configuration digest or a cohort.
CREATE FUNCTION exomem_oauth_generic_client_admitted(p_admission_mode text)
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT p_admission_mode = 'generic'
    AND EXISTS (SELECT 1 FROM exomem_oauth_generic_client_lane WHERE enabled)
$function$;

COMMENT ON FUNCTION exomem_oauth_generic_client_admitted(text) IS
  'The generic MCP client admission arm: the client is generic and the lane is '
  'enabled. Reads lane state and admission mode only.';

-- 6. The population bound gets a third partition. Generic rows leave the two
-- existing partitions, so an anonymous registration flood exhausts only its
-- own slots. The operator (96) and CIMD (128) bounds are unchanged.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partition_available(
  p_client_id text,
  p_auto_registered boolean
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM exomem_oauth_clients WHERE client_id = p_client_id
    )
    OR (
      SELECT count(*)
      FROM exomem_oauth_clients
      WHERE auto_registered = p_auto_registered
        AND admission_mode <> 'generic'
    ) < CASE WHEN p_auto_registered THEN 128 ELSE 96 END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Population bound for operator (96) and auto-registered CIMD (128) clients, '
  'partitioned by provenance. Generic clients are counted separately by '
  'exomem_oauth_generic_client_partition_available. No partition has a reclaim '
  'path: a disabled or expired client still counts.';

CREATE FUNCTION exomem_oauth_generic_client_partition_available()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (
    SELECT count(*) FROM exomem_oauth_clients WHERE admission_mode = 'generic'
  ) < 128;
$$;

COMMENT ON FUNCTION exomem_oauth_generic_client_partition_available() IS
  'Population bound for dynamically registered generic MCP clients (128), '
  'separate from the operator and CIMD partitions. Like them it has no '
  'reclaim path, so every registration holds its slot permanently.';
