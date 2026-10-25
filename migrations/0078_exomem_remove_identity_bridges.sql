-- Task 2.9 of enable-exomem-email-change: the rollback window for Release B
-- has closed, so no deployment older than Release A can run. Current code
-- creates, restores and scrubs Exomem identities and clears the theme itself.
-- The email-change cleanup trigger from 0077 stays.
-- Each drop locks exomem_tenants; fail the build rather than queue tenant reads.
SET LOCAL lock_timeout = '5s';

DROP TRIGGER exomem_tenants_copy_missing_owner ON exomem_tenants;
DROP FUNCTION exomem_copy_missing_tenant_owner();

DROP TRIGGER exomem_tenants_restore_deleted_owner ON exomem_tenants;
DROP FUNCTION exomem_restore_deleted_tenant_owner();

DROP TRIGGER exomem_tenants_scrub_deleted_owner ON exomem_tenants;
DROP FUNCTION exomem_scrub_deleted_tenant_owner();

DROP TRIGGER exomem_tenants_clear_deleted_theme ON exomem_tenants;
DROP FUNCTION exomem_clear_deleted_tenant_theme();
