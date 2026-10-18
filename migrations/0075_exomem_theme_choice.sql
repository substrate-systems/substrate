-- NULL distinguishes accounts that have not adopted a theme choice yet.
ALTER TABLE exomem_tenants
  ADD COLUMN theme_choice text CHECK (theme_choice IN ('auto', 'light', 'dark'));

ALTER TABLE exomem_waitlist_entries
  ADD COLUMN theme_choice text CHECK (theme_choice IN ('auto', 'light', 'dark'));

ALTER TABLE exomem_email_outbox
  ADD COLUMN recipient_theme_choice text CHECK (recipient_theme_choice IN ('auto', 'light', 'dark'));

-- Pre-A deletion does not know this preference. Remove this bridge in task 2.9
-- of enable-exomem-email-change after the rollback window closes.
CREATE FUNCTION exomem_clear_deleted_tenant_theme()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  NEW.theme_choice = NULL;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_tenants_clear_deleted_theme
BEFORE UPDATE OF status ON exomem_tenants
FOR EACH ROW WHEN (
  OLD.status <> 'deleted' AND NEW.status = 'deleted' AND NEW.deleted_at IS NOT NULL
)
EXECUTE FUNCTION exomem_clear_deleted_tenant_theme();
