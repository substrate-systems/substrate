-- Exomem owns its canonical identity. Shared-product identities remain unchanged.
-- Release A keeps the eight existing foreign keys on users until Release B.
CREATE TABLE exomem_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT exomem_users_identity_state CHECK (
    (deleted_at IS NULL AND email IS NOT NULL)
    OR (deleted_at IS NOT NULL AND email IS NULL AND email_verified_at IS NULL)
  )
);

-- Close the gap between the backfill snapshot and installing the insert bridge.
LOCK TABLE exomem_tenants IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO exomem_users (id, email, email_verified_at, created_at, deleted_at)
SELECT id,
       CASE WHEN identity_deleted_at IS NULL THEN email END,
       CASE WHEN identity_deleted_at IS NULL THEN email_verified_at END,
       created_at, identity_deleted_at
FROM (
  SELECT users.*,
         COALESCE(users.deleted_at, CASE WHEN tenant.status = 'deleted'
           THEN COALESCE(tenant.deleted_at, now()) END) AS identity_deleted_at
  FROM users
  LEFT JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
  WHERE users.id IN (
    SELECT owner_user_id FROM exomem_tenants
    UNION SELECT user_id FROM exomem_sessions
    UNION SELECT user_id FROM exomem_access_tokens
    UNION SELECT consumed_by_user_id FROM exomem_invites
    UNION SELECT user_id FROM exomem_transfer_grants
    UNION SELECT user_id FROM exomem_oauth_grants
    UNION SELECT owner_user_id FROM exomem_oauth_account_blocks
    UNION SELECT owner_user_id FROM exomem_marketplace_reviewer_credentials
  )
) AS identity;

-- Older in-flight admissions only know users. Remove this bridge in task 2.9
-- of enable-exomem-email-change after the rollback window closes.
CREATE FUNCTION exomem_copy_missing_tenant_owner()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  INSERT INTO exomem_users (id, email, email_verified_at, created_at, deleted_at)
  SELECT id,
         CASE WHEN deleted_at IS NULL AND NEW.status <> 'deleted' THEN email END,
         CASE WHEN deleted_at IS NULL AND NEW.status <> 'deleted' THEN email_verified_at END,
         created_at,
         COALESCE(deleted_at, CASE WHEN NEW.status = 'deleted'
           THEN COALESCE(NEW.deleted_at, now()) END)
  FROM users WHERE id = NEW.owner_user_id
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_tenants_copy_missing_owner
BEFORE INSERT ON exomem_tenants
FOR EACH ROW EXECUTE FUNCTION exomem_copy_missing_tenant_owner();

-- Older admissions update a deleted tenant. Remove this bridge in task 2.9
-- of enable-exomem-email-change after the rollback window closes.
CREATE FUNCTION exomem_restore_deleted_tenant_owner()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE exomem_users AS identity
  SET email = shared.email,
      email_verified_at = COALESCE(shared.email_verified_at, now()),
      deleted_at = NULL
  FROM users AS shared
  WHERE identity.id = NEW.owner_user_id AND shared.id = NEW.owner_user_id
    AND shared.deleted_at IS NULL
    AND identity.deleted_at IS NOT NULL AND identity.email IS NULL;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_tenants_restore_deleted_owner
BEFORE UPDATE OF status, deleted_at, owner_user_id ON exomem_tenants
FOR EACH ROW WHEN (
  OLD.status = 'deleted' AND NEW.status <> 'deleted' AND NEW.deleted_at IS NULL
  AND OLD.owner_user_id = NEW.owner_user_id
)
EXECUTE FUNCTION exomem_restore_deleted_tenant_owner();

-- Pre-A deletion reads the shared owner after this update. Scrub at commit so
-- both releases can finish their fixed notice. Remove this bridge in task 2.9
-- of enable-exomem-email-change after the rollback window closes.
CREATE FUNCTION exomem_scrub_deleted_tenant_owner()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE exomem_users AS identity
  SET email = NULL, email_verified_at = NULL,
      deleted_at = COALESCE(identity.deleted_at, tenant.deleted_at)
  FROM exomem_tenants AS tenant
  WHERE tenant.id = NEW.id AND tenant.owner_user_id = NEW.owner_user_id
    AND tenant.status = 'deleted' AND tenant.deleted_at IS NOT NULL
    AND identity.id = tenant.owner_user_id
    AND (identity.email IS NOT NULL OR identity.email_verified_at IS NOT NULL
      OR identity.deleted_at IS NULL);
  RETURN NEW;
END
$function$;

CREATE CONSTRAINT TRIGGER exomem_tenants_scrub_deleted_owner
AFTER UPDATE ON exomem_tenants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (OLD.status <> 'deleted' AND NEW.status = 'deleted')
EXECUTE FUNCTION exomem_scrub_deleted_tenant_owner();

-- Reviewer calls need this grant atomically with the predicate switch, before later migrations run.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exomem_gateway') THEN
    GRANT SELECT (id, deleted_at) ON exomem_users TO exomem_gateway;
    REVOKE SELECT (id, deleted_at) ON users FROM exomem_gateway;
  END IF;
END
$grants$;

CREATE OR REPLACE FUNCTION exomem_cloud_reviewer_tenant_eligible(target_tenant uuid, target_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM exomem_tenants AS tenant
    JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id AND owner.deleted_at IS NULL
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
