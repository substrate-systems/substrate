-- OAuth/client/contract state for Exomem Hosted MCP. Additive only.
-- Raw authorization credentials are never persisted; every credential is a SHA-256 digest.

CREATE TABLE exomem_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  admission_mode text NOT NULL CHECK (admission_mode IN ('pinned', 'cimd')),
  enabled boolean NOT NULL DEFAULT false,
  metadata_provenance jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata_provenance) = 'object'),
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(redirect_uris) = 'array'),
  metadata_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(client_id) BETWEEN 1 AND 2048)
);

CREATE TABLE exomem_oauth_authorization_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_digest bytea NOT NULL UNIQUE,
  client_id uuid NOT NULL REFERENCES exomem_oauth_clients(id) ON DELETE RESTRICT,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  requested_scopes text[] NOT NULL,
  state_digest bytea NOT NULL,
  pkce_challenge text NOT NULL,
  redeemed_session_id uuid REFERENCES exomem_sessions(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(transaction_digest) = 32),
  CHECK (octet_length(state_digest) = 32),
  CHECK (expires_at > created_at)
);

CREATE INDEX exomem_oauth_transactions_expiry_idx
  ON exomem_oauth_authorization_transactions (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE exomem_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES exomem_oauth_clients(id) ON DELETE RESTRICT,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  refresh_allowed boolean NOT NULL DEFAULT false,
  authorization_transaction_id uuid REFERENCES exomem_oauth_authorization_transactions(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX exomem_oauth_grants_active_identity_idx
  ON exomem_oauth_grants (user_id, tenant_id, client_id, resource)
  WHERE revoked_at IS NULL;

CREATE TABLE exomem_oauth_authorization_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_digest bytea NOT NULL UNIQUE,
  grant_id uuid NOT NULL REFERENCES exomem_oauth_grants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES exomem_oauth_clients(id) ON DELETE RESTRICT,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  pkce_challenge text NOT NULL,
  refresh_allowed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(code_digest) = 32),
  CHECK (expires_at > created_at)
);

CREATE INDEX exomem_oauth_codes_active_idx
  ON exomem_oauth_authorization_codes (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE exomem_oauth_token_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES exomem_oauth_grants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES exomem_oauth_clients(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX exomem_oauth_families_grant_idx
  ON exomem_oauth_token_families (grant_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE exomem_oauth_refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_digest bytea NOT NULL UNIQUE,
  family_id uuid NOT NULL REFERENCES exomem_oauth_token_families(id) ON DELETE CASCADE,
  parent_refresh_token_id uuid REFERENCES exomem_oauth_refresh_tokens(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(refresh_digest) = 32),
  CHECK (expires_at > created_at)
);

CREATE INDEX exomem_oauth_refresh_active_idx
  ON exomem_oauth_refresh_tokens (family_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE exomem_oauth_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_digest bytea NOT NULL UNIQUE,
  grant_id uuid NOT NULL REFERENCES exomem_oauth_grants(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES exomem_oauth_token_families(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES exomem_oauth_clients(id) ON DELETE RESTRICT,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(access_digest) = 32),
  CHECK (expires_at > created_at)
);

CREATE INDEX exomem_oauth_access_active_idx
  ON exomem_oauth_access_tokens (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE exomem_agent_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'live', 'retired')),
  command_fingerprint text NOT NULL,
  schema_digest text NOT NULL,
  protocol_min text NOT NULL,
  protocol_max text NOT NULL,
  contract jsonb NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
  oauth_security_schemes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(oauth_security_schemes) = 'object'),
  source_release text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  retired_at timestamptz
);

CREATE UNIQUE INDEX exomem_agent_contracts_one_live_idx
  ON exomem_agent_contracts (profile_id)
  WHERE state = 'live';
