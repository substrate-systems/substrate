-- A virgin Hosted install has no live cohort to authorize the first reviewer.
-- This one-shot authority is deliberately separate from normal client admission.

ALTER TABLE exomem_oauth_clients
  ADD COLUMN reviewer_bootstrap_ever_authorized boolean NOT NULL DEFAULT false;

CREATE TABLE exomem_marketplace_reviewer_oauth_bootstrap_authorities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true CHECK (singleton),
  state text NOT NULL CHECK (state IN ('active', 'consumed', 'revoked', 'expired')),
  invite_id uuid NOT NULL REFERENCES exomem_invites(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL REFERENCES exomem_agent_contract_candidates(id) ON DELETE RESTRICT,
  candidate_profile_id text NOT NULL,
  candidate_contract_digest text NOT NULL CHECK (candidate_contract_digest ~ '^[a-f0-9]{64}$'),
  candidate_source_release text NOT NULL,
  candidate_protocol_version text NOT NULL,
  candidate_gateway_contract_digest text NOT NULL CHECK (candidate_gateway_contract_digest ~ '^[a-f0-9]{64}$'),
  candidate_command_fingerprint text NOT NULL CHECK (candidate_command_fingerprint ~ '^[a-f0-9]{64}$'),
  candidate_schema_digest text NOT NULL CHECK (candidate_schema_digest ~ '^[a-f0-9]{64}$'),
  candidate_compatibility_digest text NOT NULL CHECK (candidate_compatibility_digest ~ '^[a-f0-9]{64}$'),
  staged_client_release_id uuid NOT NULL REFERENCES exomem_staged_client_releases(id) ON DELETE RESTRICT,
  stage_platform text NOT NULL CHECK (stage_platform IN ('claude', 'openai')),
  stage_config_sha256 text NOT NULL CHECK (stage_config_sha256 ~ '^[a-f0-9]{64}$'),
  oauth_client_id uuid NOT NULL REFERENCES exomem_oauth_clients(id) ON DELETE RESTRICT,
  oauth_client_authority_version uuid NOT NULL,
  oauth_client_config_sha256 text NOT NULL CHECK (oauth_client_config_sha256 ~ '^[a-f0-9]{64}$'),
  redirect_uri_digest bytea NOT NULL CHECK (octet_length(redirect_uri_digest) = 32),
  operator_principal_digest bytea NOT NULL CHECK (octet_length(operator_principal_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  expired_at timestamptz,
  outcome_tenant_id uuid REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  outcome_assignment_id uuid REFERENCES exomem_agent_contract_rollout_assignments(id) ON DELETE RESTRICT,
  outcome_assignment_generation bigint CHECK (outcome_assignment_generation > 0),
  outcome_operation_id uuid REFERENCES exomem_lifecycle_operations(id) ON DELETE RESTRICT,
  outcome_session_id uuid REFERENCES exomem_sessions(id) ON DELETE RESTRICT,
  outcome_grant_id uuid REFERENCES exomem_oauth_grants(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'active' AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL
      AND outcome_tenant_id IS NULL AND outcome_assignment_id IS NULL AND outcome_assignment_generation IS NULL
      AND outcome_operation_id IS NULL AND outcome_session_id IS NULL AND outcome_grant_id IS NULL)
    OR (state = 'consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL AND expired_at IS NULL
      AND outcome_tenant_id IS NOT NULL AND outcome_assignment_id IS NOT NULL AND outcome_assignment_generation IS NOT NULL
      AND outcome_operation_id IS NOT NULL AND outcome_session_id IS NOT NULL AND outcome_grant_id IS NOT NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND consumed_at IS NULL AND expired_at IS NULL
      AND outcome_tenant_id IS NULL AND outcome_assignment_id IS NULL AND outcome_assignment_generation IS NULL
      AND outcome_operation_id IS NULL AND outcome_session_id IS NULL AND outcome_grant_id IS NULL)
    OR (state = 'expired' AND expired_at IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL
      AND outcome_tenant_id IS NULL AND outcome_assignment_id IS NULL AND outcome_assignment_generation IS NULL
      AND outcome_operation_id IS NULL AND outcome_session_id IS NULL AND outcome_grant_id IS NULL)
  )
);

CREATE UNIQUE INDEX exomem_marketplace_reviewer_oauth_bootstrap_one_current_idx
  ON exomem_marketplace_reviewer_oauth_bootstrap_authorities (singleton)
  WHERE state = 'active';

CREATE UNIQUE INDEX exomem_marketplace_reviewer_oauth_bootstrap_invite_idx
  ON exomem_marketplace_reviewer_oauth_bootstrap_authorities (invite_id);

CREATE FUNCTION exomem_marketplace_reviewer_oauth_bootstrap_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (OLD.state <> 'active' AND NEW IS DISTINCT FROM OLD)
     OR NEW.singleton IS DISTINCT FROM OLD.singleton
     OR NEW.invite_id IS DISTINCT FROM OLD.invite_id
     OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
     OR NEW.candidate_profile_id IS DISTINCT FROM OLD.candidate_profile_id
     OR NEW.candidate_contract_digest IS DISTINCT FROM OLD.candidate_contract_digest
     OR NEW.candidate_source_release IS DISTINCT FROM OLD.candidate_source_release
     OR NEW.candidate_protocol_version IS DISTINCT FROM OLD.candidate_protocol_version
     OR NEW.candidate_gateway_contract_digest IS DISTINCT FROM OLD.candidate_gateway_contract_digest
     OR NEW.candidate_command_fingerprint IS DISTINCT FROM OLD.candidate_command_fingerprint
     OR NEW.candidate_schema_digest IS DISTINCT FROM OLD.candidate_schema_digest
     OR NEW.candidate_compatibility_digest IS DISTINCT FROM OLD.candidate_compatibility_digest
     OR NEW.staged_client_release_id IS DISTINCT FROM OLD.staged_client_release_id
     OR NEW.stage_platform IS DISTINCT FROM OLD.stage_platform
     OR NEW.stage_config_sha256 IS DISTINCT FROM OLD.stage_config_sha256
     OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id
     OR NEW.oauth_client_authority_version IS DISTINCT FROM OLD.oauth_client_authority_version
     OR NEW.oauth_client_config_sha256 IS DISTINCT FROM OLD.oauth_client_config_sha256
     OR NEW.redirect_uri_digest IS DISTINCT FROM OLD.redirect_uri_digest
     OR NEW.operator_principal_digest IS DISTINCT FROM OLD.operator_principal_digest
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR (OLD.state = 'active' AND NEW.state NOT IN ('active', 'consumed', 'revoked', 'expired'))
     OR (OLD.outcome_tenant_id IS NOT NULL AND (
       NEW.outcome_tenant_id IS DISTINCT FROM OLD.outcome_tenant_id
       OR NEW.outcome_assignment_id IS DISTINCT FROM OLD.outcome_assignment_id
       OR NEW.outcome_assignment_generation IS DISTINCT FROM OLD.outcome_assignment_generation
       OR NEW.outcome_operation_id IS DISTINCT FROM OLD.outcome_operation_id
       OR NEW.outcome_session_id IS DISTINCT FROM OLD.outcome_session_id
       OR NEW.outcome_grant_id IS DISTINCT FROM OLD.outcome_grant_id
     )) THEN
    RAISE EXCEPTION 'reviewer OAuth bootstrap authority is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_marketplace_reviewer_oauth_bootstrap_immutable
BEFORE UPDATE ON exomem_marketplace_reviewer_oauth_bootstrap_authorities
FOR EACH ROW EXECUTE FUNCTION exomem_marketplace_reviewer_oauth_bootstrap_immutable();

ALTER TABLE exomem_oauth_authorization_transactions
  ADD COLUMN reviewer_bootstrap_authority_id uuid
    REFERENCES exomem_marketplace_reviewer_oauth_bootstrap_authorities(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX exomem_oauth_transactions_reviewer_bootstrap_authority_idx
  ON exomem_oauth_authorization_transactions (reviewer_bootstrap_authority_id)
  WHERE reviewer_bootstrap_authority_id IS NOT NULL;

ALTER TABLE exomem_oauth_authorization_transactions
  ADD CONSTRAINT exomem_oauth_transactions_reviewer_bootstrap_lineage_check CHECK (
    reviewer_bootstrap_authority_id IS NULL
    OR (candidate_id IS NULL AND assignment_id IS NULL AND assignment_generation IS NULL
        AND staged_client_release_id IS NULL AND reviewer_credential_id IS NULL)
  );
