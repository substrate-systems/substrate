-- Marketplace reviewer credentials are pre-bound to an existing Hosted owner
-- and tenant. Plaintext credentials are never persisted.

ALTER TABLE exomem_tenants
  ADD COLUMN marketplace_reviewer_purpose boolean NOT NULL DEFAULT false;

ALTER TABLE exomem_invites
  ADD COLUMN marketplace_reviewer_purpose boolean NOT NULL DEFAULT false;

CREATE FUNCTION exomem_marketplace_reviewer_purpose_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.marketplace_reviewer_purpose IS DISTINCT FROM OLD.marketplace_reviewer_purpose THEN
    RAISE EXCEPTION 'marketplace reviewer purpose is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_tenants_reviewer_purpose_immutable
BEFORE UPDATE ON exomem_tenants
FOR EACH ROW EXECUTE FUNCTION exomem_marketplace_reviewer_purpose_is_immutable();

CREATE TRIGGER exomem_invites_reviewer_purpose_immutable
BEFORE UPDATE ON exomem_invites
FOR EACH ROW EXECUTE FUNCTION exomem_marketplace_reviewer_purpose_is_immutable();

CREATE TABLE exomem_marketplace_reviewer_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  username_digest bytea NOT NULL UNIQUE,
  password_hash text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  fixture_version text NOT NULL,
  fixture_payload_digest text NOT NULL CHECK (fixture_payload_digest ~ '^[0-9a-f]{64}$'),
  created_by_principal_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_principal_digest bytea,
  CHECK (octet_length(username_digest) = 32),
  CHECK (octet_length(created_by_principal_digest) = 32),
  CHECK (
    revoked_by_principal_digest IS NULL
    OR octet_length(revoked_by_principal_digest) = 32
  ),
  CHECK (password_hash LIKE '$argon2id$%'),
  CHECK (char_length(fixture_version) BETWEEN 1 AND 128),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX exomem_marketplace_reviewer_credentials_active_provider_idx
  ON exomem_marketplace_reviewer_credentials (provider)
  WHERE revoked_at IS NULL;

CREATE INDEX exomem_marketplace_reviewer_credentials_active_username_idx
  ON exomem_marketplace_reviewer_credentials (username_digest)
  WHERE revoked_at IS NULL;

CREATE INDEX exomem_marketplace_reviewer_credentials_tenant_idx
  ON exomem_marketplace_reviewer_credentials (tenant_id, created_at DESC);

ALTER TABLE exomem_sessions
  ADD COLUMN reviewer_credential_id uuid REFERENCES exomem_marketplace_reviewer_credentials(id) ON DELETE SET NULL;

ALTER TABLE exomem_oauth_authorization_transactions
  ADD COLUMN reviewer_credential_id uuid REFERENCES exomem_marketplace_reviewer_credentials(id) ON DELETE SET NULL;

ALTER TABLE exomem_oauth_grants
  ADD COLUMN reviewer_credential_id uuid REFERENCES exomem_marketplace_reviewer_credentials(id) ON DELETE SET NULL;

CREATE INDEX exomem_sessions_reviewer_credential_active_idx
  ON exomem_sessions (reviewer_credential_id, expires_at)
  WHERE reviewer_credential_id IS NOT NULL AND revoked_at IS NULL;

CREATE INDEX exomem_oauth_authorization_transactions_reviewer_credential_active_idx
  ON exomem_oauth_authorization_transactions (reviewer_credential_id, expires_at)
  WHERE reviewer_credential_id IS NOT NULL AND consumed_at IS NULL;

CREATE INDEX exomem_oauth_grants_reviewer_credential_active_idx
  ON exomem_oauth_grants (reviewer_credential_id, updated_at DESC)
  WHERE reviewer_credential_id IS NOT NULL AND revoked_at IS NULL;
