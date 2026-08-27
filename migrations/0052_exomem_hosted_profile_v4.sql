-- Rotate the authoritative Hosted alpha cohort views to the 0.63.1 v4
-- profile. Retained v1 candidates remain historical catalog entries and must
-- not satisfy current admission or promotion authority checks.

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
WHERE contract.profile_id = 'hosted-alpha-agent-v4'
  AND contract.state = 'live';

CREATE OR REPLACE VIEW exomem_hosted_alpha_platform_cohort AS
SELECT contract.id AS candidate_id,
       'claude'::text AS platform,
       claude.id AS artifact_id,
       claude.oauth_client_config_sha256 AS oauth_client_config_sha256
FROM exomem_agent_contract_candidates AS contract
    JOIN exomem_client_artifacts AS claude
      ON claude.platform = 'claude'
     AND claude.state = 'live'
     AND claude.package_sha256 = contract.claude_package_lock->>'artifact_sha256'
     AND claude.archive_sha256 = contract.claude_archive_lock->>'archive_sha256'
     AND claude.compatibility_sha256 = contract.claude_package_lock->>'compatibility_sha256'
     AND claude.contract_sha256 = contract.claude_package_lock->>'schema_contract_sha256'
     AND claude.plugin_version = contract.claude_package_lock->>'plugin_version'
WHERE contract.profile_id = 'hosted-alpha-agent-v4'
  AND contract.state = 'live'
UNION ALL
SELECT contract.id AS candidate_id,
       'openai'::text AS platform,
       openai.id AS artifact_id,
       openai.oauth_client_config_sha256 AS oauth_client_config_sha256
FROM exomem_agent_contract_candidates AS contract
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
WHERE contract.profile_id = 'hosted-alpha-agent-v4'
  AND contract.state = 'live';
