CREATE TABLE exomem_deletion_completion_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL)),
  CHECK (state <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX exomem_deletion_completion_outbox_ready_idx
  ON exomem_deletion_completion_outbox (next_attempt_at, created_at)
  WHERE state IN ('pending', 'leased');
