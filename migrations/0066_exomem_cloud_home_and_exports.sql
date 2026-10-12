-- Migration 0066 (Exomem Cloud part) — C6 owner exports, C1 measured disk use, export hold.
-- The shared C6 contract fixes these state, hold and error tokens; none is tenant vocabulary.
ALTER TABLE exomem_cloud_cells DROP CONSTRAINT exomem_cloud_cells_hold_kind_check;
ALTER TABLE exomem_cloud_cells ADD CONSTRAINT exomem_cloud_cells_hold_kind_check
  CHECK (hold_kind IS NULL OR hold_kind IN ('upgrade', 'backup', 'restore', 'import', 'export'));

-- Observed by cellctl from every backup and export Job's statvfs report. All three are
-- written together, so a reader sees either a whole measurement or none (unknown).
ALTER TABLE exomem_cloud_cells
  ADD COLUMN used_bytes bigint,
  ADD COLUMN filesystem_bytes bigint,
  ADD COLUMN usage_observed_at timestamptz,
  ADD CONSTRAINT exomem_cloud_cells_usage_check CHECK (
    (used_bytes IS NULL) = (filesystem_bytes IS NULL)
    AND (used_bytes IS NULL) = (usage_observed_at IS NULL)
    AND (used_bytes IS NULL OR (filesystem_bytes > 0 AND used_bytes >= 0 AND used_bytes <= filesystem_bytes))
  );

CREATE TABLE exomem_cloud_exports (
  export_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cell_id text NOT NULL REFERENCES exomem_cloud_cells(cell_id) ON DELETE RESTRICT,
  -- Substrate writes the request and the link request.
  requested_state text NOT NULL DEFAULT 'requested'
    CHECK (requested_state IN ('requested', 'superseded')),
  link_requested_at timestamptz,
  -- cellctl writes the observation.
  observed_state text CHECK (observed_state IS NULL OR observed_state IN ('packing', 'ready', 'failed', 'expired')),
  error_code text,
  archive_bytes bigint CHECK (archive_bytes IS NULL OR archive_bytes > 0),
  -- SHA-256 is a fixed hexadecimal format, not content classification.
  archive_sha256 text CHECK (archive_sha256 IS NULL OR archive_sha256 ~ '^[a-f0-9]{64}$'),
  -- The object version cellctl verified at completion; every link pins it.
  archive_version_id text,
  upload_id text,
  ready_at timestamptz,
  expires_at timestamptz,
  download_url text,
  download_url_expires_at timestamptz,
  link_issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((archive_sha256 IS NULL) = (archive_bytes IS NULL)),
  CHECK (observed_state IS DISTINCT FROM 'ready'
    OR (archive_sha256 IS NOT NULL AND ready_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (observed_state IS DISTINCT FROM 'failed' OR error_code IS NOT NULL),
  CHECK ((download_url IS NULL) = (download_url_expires_at IS NULL))
);

-- One export per cell is being packed at a time.
CREATE UNIQUE INDEX exomem_cloud_exports_open_cell_idx ON exomem_cloud_exports (cell_id)
  WHERE observed_state IS NULL OR observed_state = 'packing';
CREATE INDEX exomem_cloud_exports_cell_created_idx ON exomem_cloud_exports (cell_id, created_at DESC);

-- A request, a supersede and a link request wake cellctl; its own observation writes do not.
CREATE FUNCTION exomem_cloud_exports_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.export_id, NEW.cell_id, NEW.created_at) IS DISTINCT FROM ROW(OLD.export_id, OLD.cell_id, OLD.created_at)
       OR (OLD.requested_state = 'superseded' AND NEW.requested_state <> 'superseded') THEN
      RAISE EXCEPTION 'export request identity is immutable and a supersede is final' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('exomem_cloud_cells', NEW.cell_id);
  ELSIF ROW(NEW.requested_state, NEW.link_requested_at)
        IS DISTINCT FROM ROW(OLD.requested_state, OLD.link_requested_at) THEN
    PERFORM pg_notify('exomem_cloud_cells', NEW.cell_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER exomem_cloud_exports_touch_trigger
BEFORE INSERT OR UPDATE ON exomem_cloud_exports
FOR EACH ROW EXECUTE FUNCTION exomem_cloud_exports_touch();

-- Migration 0066 (Substrate part) — the first-party Home client.
--
-- Home reads and sets levels and reads activity through the cell's own /mcp,
-- with a short-lived token that the web server mints for this client
-- (cloud-home-mcp.ts). Its admission mode, not a client id in code, marks it:
-- the mode decides that the client is no app and takes no client slot. In
-- this release and the one before, the authorization, code exchange and
-- refresh paths admit a client by a pinned or generic mode or by admitted CIMD
-- metadata. This row has neither, and no supported writer in either version
-- gives it CIMD metadata, so those paths exclude it. Only the gateway's token
-- lookup admits the mode.
ALTER TABLE exomem_oauth_clients
  DROP CONSTRAINT exomem_oauth_clients_admission_mode_check;
ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_admission_mode_check
  CHECK (admission_mode IN ('pinned', 'cimd', 'generic', 'first_party'));

-- The Home channel mints for the one first-party client. A second one would
-- make that choice ambiguous, so the database refuses it until a change
-- decides how the channel picks between them.
CREATE UNIQUE INDEX exomem_oauth_clients_one_first_party_idx
  ON exomem_oauth_clients (admission_mode) WHERE admission_mode = 'first_party';

-- An ordinary client that already holds the Home id is not the Home client,
-- and the seed below must not rewrite it. Stop here so that an operator
-- resolves the collision; the migration otherwise succeeds without a Home
-- client, and Home fails on every call.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM exomem_oauth_clients
    WHERE client_id = 'exomem-cloud-home' AND admission_mode <> 'first_party'
  ) THEN
    RAISE EXCEPTION 'client_id exomem-cloud-home belongs to an ordinary OAuth client; '
      'rename or delete that client before migration 0066 seeds the first-party Home client';
  END IF;
END
$$;

-- The schema requires one to eight redirect URIs. The Home client never
-- completes an authorization, so its only URI uses the reserved `.invalid`
-- top-level domain (RFC 6761), which no resolver answers. A second run keeps
-- an operator's disable.
INSERT INTO exomem_oauth_clients (
  client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest, client_name
) VALUES (
  'exomem-cloud-home', 'first_party', true, '["https://exomem-cloud-home.invalid/"]'::jsonb,
  digest(convert_to('["https://exomem-cloud-home.invalid/"]'::jsonb::text, 'utf8'), 'sha256'),
  'Exomem Home'
) ON CONFLICT (client_id) DO NOTHING;

-- Each Home mint deletes its own grant's expired access tokens
-- (cloud-home-mcp.ts). This index finds them without reading the whole table.
CREATE INDEX exomem_oauth_access_tokens_grant_expiry_idx
  ON exomem_oauth_access_tokens (grant_id, expires_at);

-- Migration 0060 seeded the CLI client before stored client names existed.
UPDATE exomem_oauth_clients SET client_name = 'Exomem CLI'
WHERE client_id = 'exomem-cloud-cli' AND client_name IS NULL;

-- The operator partition no longer counts first-party clients. Everything
-- else is migration 0062's definition unchanged.
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
        AND admission_mode IN ('pinned', 'cimd')
    ) < CASE WHEN p_auto_registered THEN 128 ELSE 96 END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Population bound for operator (96) and auto-registered CIMD (128) clients, '
  'partitioned by provenance. Generic clients are counted separately by '
  'exomem_oauth_generic_client_partition_available, and first-party clients '
  'take no slot. No partition has a reclaim path: a disabled or expired client '
  'still counts.';
