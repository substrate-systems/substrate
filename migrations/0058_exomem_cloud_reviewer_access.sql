-- Cloud reviewer credentials reuse the existing bounded OAuth lineage without
-- inheriting Hosted candidate or artifact authority.
ALTER TABLE exomem_marketplace_reviewer_credentials
  DROP CONSTRAINT exomem_marketplace_reviewer_credentials_credential_kind_check,
  DROP CONSTRAINT exomem_reviewer_credentials_candidate_lineage_complete,
  ADD CONSTRAINT exomem_marketplace_reviewer_credentials_credential_kind_check
    CHECK (credential_kind IN ('provider_review', 'internal_canary', 'cloud_provider_review')),
  ADD CONSTRAINT exomem_reviewer_credentials_candidate_lineage_complete CHECK (
    (credential_kind IN ('provider_review', 'cloud_provider_review')
      AND candidate_id IS NULL AND assignment_id IS NULL AND assignment_generation IS NULL
      AND staged_client_release_id IS NULL AND oauth_client_id IS NULL)
    OR (credential_kind = 'internal_canary'
      AND candidate_id IS NOT NULL AND assignment_id IS NOT NULL AND assignment_generation IS NOT NULL
      AND staged_client_release_id IS NOT NULL AND oauth_client_id IS NOT NULL)
  );

CREATE UNIQUE INDEX exomem_cloud_reviewer_credentials_active_provider_idx
  ON exomem_marketplace_reviewer_credentials (provider)
  WHERE revoked_at IS NULL AND credential_kind = 'cloud_provider_review';

-- Rechecked at every reviewer boundary, including gateway reads. These are
-- invoker predicates: callers still own resource, flag, admission and locking.
CREATE FUNCTION exomem_cloud_reviewer_tenant_eligible(target_tenant uuid, target_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM exomem_tenants AS tenant
    JOIN users ON users.id = tenant.owner_user_id AND users.deleted_at IS NULL
    JOIN exomem_cloud_cells AS cell ON cell.tenant_id = tenant.id AND cell.desired_state = 'running'
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
    WHERE tenant.id = target_tenant AND tenant.owner_user_id = target_user
      AND tenant.marketplace_reviewer_purpose = true
      AND tenant.status IN ('provisioning', 'active') AND tenant.desired_state = 'running'
      AND tenant.deleted_at IS NULL
      AND entitlement.source = 'complimentary'
      AND entitlement.source_state = 'complimentary_active' AND entitlement.effective_state = 'active'
      AND entitlement.provider_customer_ref IS NULL
      AND entitlement.provider_subscription_ref IS NULL AND entitlement.provider_transaction_ref IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = tenant.id AND block.owner_user_id = target_user
      )
  )
$function$;

CREATE FUNCTION exomem_cloud_reviewer_authorized(target_credential uuid, target_tenant uuid, target_user uuid, platform text)
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM exomem_marketplace_reviewer_credentials AS credential
    WHERE credential.id = target_credential AND credential.tenant_id = target_tenant
      AND credential.owner_user_id = target_user AND credential.credential_kind = 'cloud_provider_review'
      AND credential.revoked_at IS NULL AND credential.expires_at > now()
      AND (platform IS NULL OR (credential.provider = 'openai' AND platform = 'openai')
        OR (credential.provider = 'anthropic' AND platform = 'claude'))
      AND exomem_cloud_reviewer_tenant_eligible(target_tenant, target_user)
  )
$function$;
