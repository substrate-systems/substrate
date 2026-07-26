-- Imported Exomem Hosted contracts and client distribution evidence. Additive only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE exomem_agent_contract_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL CHECK (state IN ('pending', 'live', 'failed', 'retired')),
  profile_id text NOT NULL,
  endpoint text NOT NULL,
  source_release text NOT NULL,
  command_fingerprint text NOT NULL CHECK (char_length(command_fingerprint) = 64),
  schema_digest text NOT NULL CHECK (char_length(schema_digest) = 64),
  compatibility_digest text NOT NULL CHECK (char_length(compatibility_digest) = 64),
  protocol_version text NOT NULL,
  contract jsonb NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
  package_lock jsonb NOT NULL CHECK (jsonb_typeof(package_lock) = 'object'),
  archive_lock jsonb NOT NULL CHECK (jsonb_typeof(archive_lock) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  retired_at timestamptz,
  CHECK ((state IN ('live', 'retired')) = (promoted_at IS NOT NULL)),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX exomem_agent_contract_candidates_one_live_idx
  ON exomem_agent_contract_candidates (profile_id) WHERE state = 'live';

CREATE TABLE exomem_routable_cell_contracts (
  cell_id uuid NOT NULL REFERENCES exomem_cells(id) ON DELETE RESTRICT,
  profile_id text NOT NULL,
  source_release text NOT NULL,
  protocol_version text NOT NULL,
  command_fingerprint text NOT NULL CHECK (char_length(command_fingerprint) = 64),
  contract_digest text NOT NULL CHECK (char_length(contract_digest) = 64),
  compatibility_digest text NOT NULL CHECK (char_length(compatibility_digest) = 64),
  routable boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cell_id, profile_id)
);

CREATE TABLE exomem_agent_contract_profile_authority (
  profile_id text PRIMARY KEY,
  routable_set_digest text NOT NULL CHECK (char_length(routable_set_digest) = 64),
  routable_cell_count integer NOT NULL CHECK (routable_cell_count >= 0),
  source_release text NOT NULL,
  protocol_version text NOT NULL,
  command_fingerprint text NOT NULL CHECK (char_length(command_fingerprint) = 64),
  contract_digest text NOT NULL CHECK (char_length(contract_digest) = 64),
  compatibility_digest text NOT NULL CHECK (char_length(compatibility_digest) = 64),
  observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exomem_client_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('claude', 'openai')),
  state text NOT NULL CHECK (state IN ('pending', 'live', 'failed', 'retired')),
  package_sha256 text NOT NULL CHECK (char_length(package_sha256) = 64),
  archive_sha256 text NOT NULL CHECK (char_length(archive_sha256) = 64),
  compatibility_sha256 text NOT NULL CHECK (char_length(compatibility_sha256) = 64),
  contract_sha256 text NOT NULL CHECK (char_length(contract_sha256) = 64),
  plugin_version text NOT NULL,
  client_identity_sha256 text NOT NULL CHECK (char_length(client_identity_sha256) = 64),
  install_url text NOT NULL,
  evidence_sha256 text NOT NULL CHECK (char_length(evidence_sha256) = 64),
  result_sha256 text NOT NULL CHECK (char_length(result_sha256) = 64),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  retired_at timestamptz,
  failed_at timestamptz,
  CHECK (
    (state = 'pending' AND promoted_at IS NULL AND retired_at IS NULL AND failed_at IS NULL)
    OR (state = 'live' AND promoted_at IS NOT NULL AND retired_at IS NULL AND failed_at IS NULL)
    OR (state = 'retired' AND promoted_at IS NOT NULL AND retired_at IS NOT NULL AND failed_at IS NULL)
    OR (state = 'failed' AND promoted_at IS NOT NULL AND retired_at IS NULL AND failed_at IS NOT NULL)
  ),
  CHECK (install_url ~ '^https://')
);

CREATE UNIQUE INDEX exomem_client_artifacts_one_live_idx
  ON exomem_client_artifacts (platform) WHERE state = 'live';
