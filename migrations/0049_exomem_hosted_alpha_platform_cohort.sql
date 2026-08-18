-- Per-platform cohort liveness.
--
-- exomem_hosted_alpha_cohort inner-joins a live claude artifact AND a live
-- openai artifact, so it reports nothing until BOTH platforms are promoted.
-- Every admission predicate gates on that view, which means no Claude client
-- can be admitted until an OpenAI asdk_app_* is registered -- a coupling that
-- never described the requesting client.
--
-- The approved spec for admit-cimd-clients-by-host already required "a live
-- cohort exists for the client's platform", with a scenario named "No live
-- cohort exists for the platform". No per-platform cohort existed, so that
-- requirement was implemented as the paired one. This view makes it
-- expressible.
--
-- Each platform keeps its own join shape exactly as the paired view defines it.
-- The claude side matches the package/archive/compatibility/contract/plugin
-- locks; the openai side additionally requires contract_candidate_id and the
-- registered app id on both locks. Neither is loosened here.
--
-- The paired view is deliberately retained unchanged: it still expresses "both
-- platforms proven", which remains the marketplace-launch gate even though it
-- is no longer the admission gate.

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
WHERE contract.profile_id = 'hosted-alpha-agent-v1'
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
WHERE contract.profile_id = 'hosted-alpha-agent-v1'
  AND contract.state = 'live';
