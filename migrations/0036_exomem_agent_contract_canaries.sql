-- Durable, operator-owned canary contract state. Additive only.

CREATE TABLE exomem_agent_contract_rollout_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL REFERENCES exomem_agent_contract_candidates(id) ON DELETE RESTRICT,
  generation bigint NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('preparing', 'active', 'failed', 'expired', 'retired')),
  source_release text NOT NULL,
  protocol_version text NOT NULL,
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  compatibility_digest text NOT NULL CHECK (compatibility_digest ~ '^[a-f0-9]{64}$'),
  gateway_contract_digest text NOT NULL CHECK (gateway_contract_digest ~ '^[a-f0-9]{64}$'),
  marketplace_reviewer_purpose boolean NOT NULL,
  created_by_principal_digest text NOT NULL CHECK (created_by_principal_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  activated_at timestamptz,
  ended_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, generation),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '7 days'),
  CHECK ((state = 'active') = (activated_at IS NOT NULL)),
  CHECK ((state IN ('failed', 'expired', 'retired')) = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX exomem_agent_contract_rollout_assignments_one_current_idx
  ON exomem_agent_contract_rollout_assignments (tenant_id)
  WHERE state IN ('preparing', 'active');

CREATE INDEX exomem_agent_contract_rollout_assignments_candidate_idx
  ON exomem_agent_contract_rollout_assignments (candidate_id, state, expires_at);

CREATE FUNCTION exomem_agent_contract_rollout_assignment_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
     OR NEW.generation IS DISTINCT FROM OLD.generation
     OR NEW.source_release IS DISTINCT FROM OLD.source_release
     OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
     OR NEW.command_fingerprint IS DISTINCT FROM OLD.command_fingerprint
     OR NEW.schema_digest IS DISTINCT FROM OLD.schema_digest
     OR NEW.compatibility_digest IS DISTINCT FROM OLD.compatibility_digest
     OR NEW.gateway_contract_digest IS DISTINCT FROM OLD.gateway_contract_digest
     OR NEW.marketplace_reviewer_purpose IS DISTINCT FROM OLD.marketplace_reviewer_purpose
     OR NEW.created_by_principal_digest IS DISTINCT FROM OLD.created_by_principal_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'rollout assignment target is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_agent_contract_rollout_assignment_immutable
BEFORE UPDATE ON exomem_agent_contract_rollout_assignments
FOR EACH ROW EXECUTE FUNCTION exomem_agent_contract_rollout_assignment_is_immutable();

CREATE TABLE exomem_staged_client_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES exomem_agent_contract_candidates(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('claude', 'openai')),
  state text NOT NULL CHECK (state IN ('staged', 'evidenced', 'failed', 'expired', 'retired')),
  package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[a-f0-9]{64}$'),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  compatibility_sha256 text NOT NULL CHECK (compatibility_sha256 ~ '^[a-f0-9]{64}$'),
  contract_sha256 text NOT NULL CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  plugin_version text NOT NULL,
  oauth_client_config_sha256 text NOT NULL CHECK (oauth_client_config_sha256 ~ '^[a-f0-9]{64}$'),
  registered_app_id_sha256 text CHECK (registered_app_id_sha256 IS NULL OR registered_app_id_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_principal_digest text NOT NULL CHECK (created_by_principal_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  evidenced_at timestamptz,
  ended_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, platform),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '7 days'),
  CHECK ((platform = 'openai') = (registered_app_id_sha256 IS NOT NULL)),
  CHECK ((state = 'evidenced') = (evidenced_at IS NOT NULL)),
  CHECK ((state IN ('failed', 'expired', 'retired')) = (ended_at IS NOT NULL))
);

CREATE UNIQUE INDEX exomem_staged_client_releases_candidate_platform_current_idx
  ON exomem_staged_client_releases (candidate_id, platform)
  WHERE state IN ('staged', 'evidenced');

CREATE INDEX exomem_staged_client_releases_expiry_idx
  ON exomem_staged_client_releases (state, expires_at);

CREATE FUNCTION exomem_staged_client_release_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.package_sha256 IS DISTINCT FROM OLD.package_sha256
     OR NEW.archive_sha256 IS DISTINCT FROM OLD.archive_sha256
     OR NEW.compatibility_sha256 IS DISTINCT FROM OLD.compatibility_sha256
     OR NEW.contract_sha256 IS DISTINCT FROM OLD.contract_sha256
     OR NEW.plugin_version IS DISTINCT FROM OLD.plugin_version
     OR NEW.oauth_client_config_sha256 IS DISTINCT FROM OLD.oauth_client_config_sha256
     OR NEW.registered_app_id_sha256 IS DISTINCT FROM OLD.registered_app_id_sha256
     OR NEW.created_by_principal_digest IS DISTINCT FROM OLD.created_by_principal_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'staged client release target is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_staged_client_release_immutable
BEFORE UPDATE ON exomem_staged_client_releases
FOR EACH ROW EXECUTE FUNCTION exomem_staged_client_release_is_immutable();

ALTER TABLE exomem_client_artifacts
  ADD COLUMN staged_client_release_id uuid REFERENCES exomem_staged_client_releases(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX exomem_client_artifacts_staged_client_release_idx
  ON exomem_client_artifacts (staged_client_release_id)
  WHERE staged_client_release_id IS NOT NULL;
