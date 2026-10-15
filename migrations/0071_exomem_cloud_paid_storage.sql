-- Paid storage operations persist across provider timeouts and browser reloads.
ALTER TABLE exomem_entitlements
  ADD COLUMN paid_storage_bytes bigint NOT NULL DEFAULT 0 CHECK (paid_storage_bytes >= 0);

ALTER TABLE exomem_cloud_cells
  ADD COLUMN observed_storage_pvc_uid text,
  ADD COLUMN observed_storage_pvc_version text,
  ADD COLUMN observed_storage_capacity_bytes bigint CHECK (observed_storage_capacity_bytes > 0),
  ADD COLUMN observed_storage_generation bigint CHECK (observed_storage_generation > 0),
  ADD COLUMN observed_storage_at timestamptz;

CREATE TABLE exomem_cloud_storage_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  cell_id text NOT NULL REFERENCES exomem_cloud_cells(cell_id) ON DELETE CASCADE,
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  subscription_ref text NOT NULL,
  state text NOT NULL CHECK (state IN (
    'preview', 'updating', 'unknown', 'payment_required', 'paid', 'applied', 'failed', 'superseded'
  )),
  baseline_fingerprint text NOT NULL,
  baseline_items jsonb NOT NULL CHECK (jsonb_typeof(baseline_items) = 'array'),
  target_items jsonb NOT NULL CHECK (jsonb_typeof(target_items) = 'array'),
  storage_price_id text NOT NULL,
  added_quantity int NOT NULL CHECK (added_quantity > 0),
  added_bytes bigint NOT NULL CHECK (added_bytes > 0),
  paid_bytes_after bigint NOT NULL CHECK (paid_bytes_after >= added_bytes),
  target_storage_gib int NOT NULL CHECK (target_storage_gib > 0),
  target_generation bigint,
  pvc_uid text NOT NULL,
  quote jsonb NOT NULL CHECK (jsonb_typeof(quote) = 'object'),
  quote_expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  attempt_id uuid,
  payment_transaction_id text,
  payment_facts jsonb,
  applied_capacity_bytes bigint CHECK (applied_capacity_bytes > 0),
  recovery_transaction_id text,
  provider_checked_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX exomem_cloud_storage_unfinished_idx
  ON exomem_cloud_storage_operations (provider_environment, subscription_ref)
  WHERE state NOT IN ('applied', 'failed', 'superseded');

CREATE INDEX exomem_cloud_storage_owner_idx
  ON exomem_cloud_storage_operations (tenant_id, created_at DESC);

-- A changed desired size wakes the same controller without trusting pod readiness.
CREATE OR REPLACE FUNCTION exomem_cloud_cells_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('exomem_cloud_cells', NEW.cell_id);
  ELSIF NEW.desired_state IS DISTINCT FROM OLD.desired_state
     OR NEW.desired_image IS DISTINCT FROM OLD.desired_image
     OR NEW.storage_gib IS DISTINCT FROM OLD.storage_gib THEN
    NEW.generation := OLD.generation + 1;
    PERFORM pg_notify('exomem_cloud_cells', NEW.cell_id);
  END IF;
  RETURN NEW;
END;
$$;
