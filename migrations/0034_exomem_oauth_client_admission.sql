-- Operator-managed OAuth client admission. Legacy rows remain stored but
-- runtime authority fails closed until their signed configuration is rebound.

ALTER TABLE exomem_client_artifacts
  ADD COLUMN oauth_client_config_sha256 text;

ALTER TABLE exomem_oauth_clients
  ADD COLUMN metadata_document_digest bytea,
  ADD COLUMN redirect_uris_digest bytea,
  ADD COLUMN metadata_fetched_at timestamptz,
  ADD COLUMN metadata_ttl_seconds integer,
  ADD COLUMN cimd_host text,
  ADD COLUMN client_platform text,
  ADD COLUMN oauth_client_config_sha256 text,
  ADD COLUMN authority_version uuid DEFAULT gen_random_uuid();

UPDATE exomem_oauth_clients
SET redirect_uris_digest = digest(convert_to(redirect_uris::text, 'utf8'), 'sha256'),
    authority_version = COALESCE(authority_version, gen_random_uuid())
WHERE redirect_uris_digest IS NULL
  AND jsonb_array_length(redirect_uris) BETWEEN 1 AND 8;

ALTER TABLE exomem_client_artifacts
  ADD CONSTRAINT exomem_client_artifacts_oauth_client_config_sha256_valid
  CHECK (oauth_client_config_sha256 IS NULL OR oauth_client_config_sha256 ~ '^[a-f0-9]{64}$') NOT VALID;

ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_redirect_limit
  CHECK (jsonb_array_length(redirect_uris) BETWEEN 1 AND 8) NOT VALID,
  ADD CONSTRAINT exomem_oauth_clients_redirect_digest_valid
  CHECK (
    redirect_uris_digest IS NOT NULL
    AND octet_length(redirect_uris_digest) = 32
    AND redirect_uris_digest = digest(convert_to(redirect_uris::text, 'utf8'), 'sha256')
  ) NOT VALID,
  ADD CONSTRAINT exomem_oauth_clients_cimd_metadata_valid
  CHECK (
    admission_mode <> 'cimd' OR (
      metadata_document_digest IS NOT NULL AND octet_length(metadata_document_digest) = 32 AND
      metadata_fetched_at IS NOT NULL AND
      metadata_ttl_seconds BETWEEN 300 AND 604800 AND
      metadata_expires_at IS NOT NULL AND
      cimd_host IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT exomem_oauth_clients_config_sha256_valid
  CHECK (
    (client_platform IS NULL) = (oauth_client_config_sha256 IS NULL)
    AND (client_platform IS NULL OR client_platform IN ('claude', 'openai'))
    AND (oauth_client_config_sha256 IS NULL OR oauth_client_config_sha256 ~ '^[a-f0-9]{64}$')
  ) NOT VALID;

CREATE OR REPLACE VIEW exomem_hosted_alpha_cohort AS
SELECT contract.id,
       claude.id AS claude_artifact_id,
       claude.oauth_client_config_sha256 AS claude_oauth_client_config_sha256,
       openai.id AS openai_artifact_id,
       openai.oauth_client_config_sha256 AS openai_oauth_client_config_sha256
FROM exomem_agent_contract_candidates AS contract
    JOIN exomem_client_artifacts AS claude
      ON claude.platform = 'claude'
     AND claude.state = 'live'
     AND claude.package_sha256 = contract.claude_package_lock->>'artifact_sha256'
     AND claude.archive_sha256 = contract.claude_archive_lock->>'archive_sha256'
     AND claude.compatibility_sha256 = contract.claude_package_lock->>'compatibility_sha256'
     AND claude.contract_sha256 = contract.claude_package_lock->>'schema_contract_sha256'
     AND claude.plugin_version = contract.claude_package_lock->>'plugin_version'
    JOIN exomem_client_artifacts AS openai
      ON openai.platform = 'openai'
     AND openai.state = 'live'
     AND openai.contract_candidate_id = contract.id
     AND openai.registered_app_id_sha256 = contract.openai_package_lock->>'registered_app_id_sha256'
     AND openai.registered_app_id_sha256 = contract.openai_archive_lock->>'registered_app_id_sha256'
     AND openai.package_sha256 = contract.openai_package_lock->>'artifact_sha256'
     AND openai.archive_sha256 = contract.openai_archive_lock->>'archive_sha256'
     AND openai.compatibility_sha256 = contract.openai_package_lock->>'compatibility_sha256'
     AND openai.contract_sha256 = contract.openai_package_lock->>'schema_contract_sha256'
     AND openai.plugin_version = contract.openai_package_lock->>'plugin_version'
WHERE contract.profile_id = 'hosted-alpha-agent-v1'
  AND contract.state = 'live';
