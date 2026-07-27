-- Durable operator OAuth denial is authoritative per owned tenant. An account
-- remains denied after deletion; alpha has no implicit unblock transition.
CREATE TABLE exomem_oauth_account_blocks (
  tenant_id uuid PRIMARY KEY REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  blocked_reason text NOT NULL CHECK (blocked_reason IN ('operator_revoked', 'lifecycle_deleted')),
  CHECK (char_length(blocked_reason) <= 64)
);

CREATE INDEX exomem_oauth_account_blocks_owner_idx
  ON exomem_oauth_account_blocks (owner_user_id, tenant_id);

-- Authorization has no client-to-platform mapping. It is eligible only while
-- the one hosted profile and both independently live artifacts match its locks.
CREATE VIEW exomem_hosted_alpha_cohort AS
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
     AND openai.package_sha256 = contract.openai_package_lock->>'artifact_sha256'
     AND openai.archive_sha256 = contract.openai_archive_lock->>'archive_sha256'
     AND openai.compatibility_sha256 = contract.openai_package_lock->>'compatibility_sha256'
     AND openai.contract_sha256 = contract.openai_package_lock->>'schema_contract_sha256'
     AND openai.plugin_version = contract.openai_package_lock->>'plugin_version'
WHERE contract.profile_id = 'hosted-alpha-agent-v1'
  AND contract.state = 'live';
