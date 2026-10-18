CREATE TABLE exomem_email_changes (
  tenant_id uuid PRIMARY KEY REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  original_email citext NOT NULL,
  proposed_email citext NOT NULL,
  confirmation_digest bytea NOT NULL UNIQUE CHECK (octet_length(confirmation_digest) = 32),
  cancellation_digest bytea NOT NULL UNIQUE CHECK (octet_length(cancellation_digest) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (original_email <> proposed_email),
  CHECK (expires_at > created_at)
);
CREATE INDEX exomem_email_changes_expiry_idx ON exomem_email_changes (expires_at);

CREATE TABLE exomem_paddle_receipt_contacts (
  tenant_id uuid PRIMARY KEY REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  desired_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'synchronized', 'conflict', 'failed')),
  provider_environment text CHECK (provider_environment IN ('sandbox', 'production')),
  provider_customer_ref text,
  observed_email text,
  observed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((provider_environment IS NULL AND provider_customer_ref IS NULL AND observed_email IS NULL AND observed_at IS NULL)
    OR (provider_environment IS NOT NULL AND provider_customer_ref IS NOT NULL AND observed_email IS NOT NULL AND observed_at IS NOT NULL))
);
CREATE INDEX exomem_paddle_receipt_contacts_due_idx ON exomem_paddle_receipt_contacts (next_attempt_at)
  WHERE state IN ('pending', 'synchronized');

-- The outbox kinds are the fixed email capabilities defined by this migration.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox ADD CONSTRAINT exomem_email_outbox_kind_check CHECK (
  kind IN ('start', 'place_opened', 'waitlist', 'hold_reminder', 'ready', 'payment_failed',
    'subscription_ended', 'deletion_reminder', 'deleted', 'invitation', 'friend_invitation', 'covered_invitation',
    'invitation_reminder', 'invitation_used', 'invitation_ended',
    'email_change_confirmation', 'email_change_cancellation')
);

-- A rollback to Release A still purges B-owned PII before fresh re-admission can write it.
CREATE FUNCTION exomem_clear_email_change_state()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  DELETE FROM exomem_email_changes WHERE tenant_id = NEW.id;
  DELETE FROM exomem_paddle_receipt_contacts WHERE tenant_id = NEW.id;
  RETURN NEW;
END
$function$;
CREATE TRIGGER exomem_tenants_clear_email_change_state
AFTER UPDATE OF status ON exomem_tenants
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('deletion_pending', 'deleted'))
EXECUTE FUNCTION exomem_clear_email_change_state();
