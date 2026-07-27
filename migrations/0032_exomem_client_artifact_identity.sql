-- Bind future OpenAI artifact evidence to the exact reviewed contract candidate.

ALTER TABLE exomem_client_artifacts
  ADD COLUMN contract_candidate_id uuid REFERENCES exomem_agent_contract_candidates(id) ON DELETE RESTRICT,
  ADD COLUMN registered_app_id_sha256 text CHECK (
    registered_app_id_sha256 IS NULL OR registered_app_id_sha256 ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE exomem_client_artifacts
  ADD CONSTRAINT exomem_client_artifacts_openai_contract_identity_check
  CHECK (
    platform <> 'openai'
    OR (contract_candidate_id IS NOT NULL AND registered_app_id_sha256 IS NOT NULL)
  ) NOT VALID;

-- Rebuild the rollout cohort against the exact registered OpenAI app and
-- contract candidate. Legacy unbound OpenAI rows remain stored for audit but
-- cannot authorize or serve MCP traffic.
CREATE OR REPLACE VIEW exomem_hosted_alpha_cohort AS
SELECT contract.id
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
