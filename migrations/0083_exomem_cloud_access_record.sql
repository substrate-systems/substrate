-- Retained provider receipts and content-free access metadata. Independent of 0080.
CREATE TABLE exomem_cloud_access_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  provider_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  UNIQUE (bucket_id, object_key, version_id)
);
CREATE INDEX exomem_cloud_access_receipts_pending_idx
  ON exomem_cloud_access_receipts (next_attempt_at, received_at) WHERE processed_at IS NULL;

-- A Pod UID and node come from Kubernetes. Observation bounds never backfill
-- an unobserved node assignment from the cell's current row.
CREATE TABLE exomem_cloud_placements (
  cell_id text NOT NULL REFERENCES exomem_cloud_cells(cell_id) ON DELETE RESTRICT,
  pod_uid text NOT NULL,
  node text NOT NULL,
  source_created_at timestamptz,
  source_deletion_requested_at timestamptz,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  workload_kind text NOT NULL,
  workload_uid text NOT NULL,
  phase text,
  PRIMARY KEY (cell_id, pod_uid, first_observed_at),
  CHECK (last_observed_at >= first_observed_at)
);
CREATE INDEX exomem_cloud_placements_node_idx
  ON exomem_cloud_placements (node, first_observed_at, last_observed_at);

-- These values are the access-record wire protocol, not a tenant vocabulary.
CREATE TABLE exomem_cloud_access_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES exomem_cloud_access_receipts(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('kubernetes', 'node_session', 'sudo', 'heartbeat', 'shipper_metric')),
  source_at timestamptz NOT NULL,
  provider_at timestamptz NOT NULL,
  node text NOT NULL,
  boot_id text NOT NULL,
  event_id text NOT NULL,
  identity text,
  identity_tier text NOT NULL CHECK (identity_tier IN ('routine', 'deploy', 'admin', 'service', 'unknown')),
  action text NOT NULL,
  target text,
  namespace text,
  resource text,
  subresource text,
  session_id text,
  authentication_method text,
  fingerprint text,
  fingerprint_kind text,
  source_address text,
  result text,
  UNIQUE (receipt_id, line_number)
);
CREATE INDEX exomem_cloud_access_records_session_idx
  ON exomem_cloud_access_records (node, boot_id, session_id, source_at)
  WHERE kind = 'node_session';
CREATE INDEX exomem_cloud_access_records_heartbeat_idx
  ON exomem_cloud_access_records (node, source_at) WHERE kind = 'heartbeat';

CREATE TABLE exomem_cloud_access_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cell_id text NOT NULL REFERENCES exomem_cloud_cells(cell_id) ON DELETE RESTRICT,
  record_id uuid NOT NULL REFERENCES exomem_cloud_access_records(id) ON DELETE CASCADE,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cell_id, record_id)
);

-- Possession grants retain no address or address fingerprint after identity erasure.
CREATE TABLE exomem_cloud_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  cell_id text NOT NULL REFERENCES exomem_cloud_cells(cell_id) ON DELETE RESTRICT,
  code_digest bytea NOT NULL UNIQUE CHECK (octet_length(code_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE exomem_cloud_access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES exomem_cloud_access_grants(id) ON DELETE CASCADE,
  session_digest bytea NOT NULL UNIQUE CHECK (octet_length(session_digest) = 32),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE exomem_cloud_access_challenges (
  challenge_digest bytea PRIMARY KEY CHECK (octet_length(challenge_digest) = 32),
  expires_at timestamptz NOT NULL
);

CREATE INDEX exomem_cloud_access_grants_expiry_idx ON exomem_cloud_access_grants(expires_at);
CREATE INDEX exomem_cloud_access_sessions_expiry_idx ON exomem_cloud_access_sessions(expires_at);
CREATE INDEX exomem_cloud_access_challenges_expiry_idx ON exomem_cloud_access_challenges(expires_at);

-- The wire schema fixes access kinds. Heartbeat and metric series never become access entries.
CREATE INDEX exomem_cloud_access_records_attribution_idx
  ON exomem_cloud_access_records (provider_at,id)
  WHERE kind IN ('kubernetes','node_session','sudo');

CREATE INDEX exomem_cloud_access_records_metrics_idx
  ON exomem_cloud_access_records (node,target,source_at DESC)
  WHERE kind = 'shipper_metric';
