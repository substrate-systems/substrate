-- Migration 0017 — Exomem Hosted product-scoped control-plane foundation.
-- Additive only: existing Endstate users and product tables are unchanged.
-- The repository migration runner splits on semicolons, so this migration
-- deliberately uses plain DDL and contains no procedural blocks.

CREATE TABLE exomem_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'deletion_pending', 'deleted')),
  desired_state text NOT NULL DEFAULT 'running'
    CHECK (desired_state IN ('running', 'suspended', 'deleted')),
  bound_cell_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX exomem_tenants_status_idx ON exomem_tenants (status, updated_at);

CREATE TABLE exomem_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  lifecycle_state text NOT NULL DEFAULT 'provisioning'
    CHECK (lifecycle_state IN (
      'provisioning', 'active', 'draining', 'quiesced', 'restoring',
      'stopped', 'sealed', 'failed', 'retired', 'deleted'
    )),
  routing_state text NOT NULL DEFAULT 'unbound'
    CHECK (routing_state IN ('unbound', 'bound', 'retiring')),
  desired_state text NOT NULL DEFAULT 'running'
    CHECK (desired_state IN ('running', 'quiesced', 'stopped', 'deleted')),
  protocol_version text NOT NULL,
  release_version text NOT NULL,
  worker_policy jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(worker_policy) = 'object'),
  provider_ref text,
  private_endpoint_ciphertext jsonb,
  service_credential_ciphertext jsonb,
  service_credential_digest bytea UNIQUE,
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  pending_service_credential_ciphertext jsonb,
  pending_service_credential_digest bytea UNIQUE,
  pending_credential_version integer,
  bound_at timestamptz,
  last_liveness_at timestamptz,
  last_readiness_at timestamptz,
  readiness_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (
    service_credential_digest IS NULL
    OR octet_length(service_credential_digest) = 32
  ),
  CHECK (
    (pending_service_credential_ciphertext IS NULL
      AND pending_service_credential_digest IS NULL
      AND pending_credential_version IS NULL)
    OR
    (pending_service_credential_ciphertext IS NOT NULL
      AND octet_length(pending_service_credential_digest) = 32
      AND pending_credential_version = credential_version + 1)
  )
);

ALTER TABLE exomem_tenants
  ADD CONSTRAINT exomem_tenants_bound_cell_fk
  FOREIGN KEY (id, bound_cell_id)
  REFERENCES exomem_cells (tenant_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX exomem_cells_one_bound_per_tenant_idx
  ON exomem_cells (tenant_id)
  WHERE routing_state = 'bound';

CREATE INDEX exomem_cells_tenant_history_idx
  ON exomem_cells (tenant_id, created_at DESC);

CREATE TABLE exomem_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('complimentary', 'paddle')),
  source_state text NOT NULL,
  effective_state text NOT NULL
    CHECK (effective_state IN ('provisioning', 'active', 'grace', 'suspended', 'cancelled', 'deleted')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(capabilities) = 'array'),
  resource_limits jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(resource_limits) = 'object'),
  manual_suspended_at timestamptz,
  source_revision text,
  source_occurred_at timestamptz,
  provider_customer_ref text,
  provider_subscription_ref text,
  provider_transaction_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX exomem_entitlements_effective_state_idx
  ON exomem_entitlements (effective_state, updated_at);

CREATE TABLE exomem_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  session_digest bytea NOT NULL UNIQUE,
  csrf_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  rotated_from_session_id uuid UNIQUE REFERENCES exomem_sessions(id) ON DELETE SET NULL,
  CHECK (octet_length(session_digest) = 32),
  CHECK (octet_length(csrf_digest) = 32),
  CHECK (expires_at > created_at)
);

CREATE INDEX exomem_sessions_user_active_idx
  ON exomem_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX exomem_sessions_tenant_active_idx
  ON exomem_sessions (tenant_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE exomem_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('magic_link', 'deletion_confirmation')),
  token_digest bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  delivery_state text NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sent', 'failed')),
  delivered_at timestamptz,
  delivery_error_code text,
  CHECK (octet_length(token_digest) = 32),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX exomem_access_tokens_valid_idx
  ON exomem_access_tokens (purpose, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE exomem_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_digest bytea NOT NULL UNIQUE,
  email_normalized citext NOT NULL,
  entitlement_source text NOT NULL
    CHECK (entitlement_source IN ('complimentary', 'paddle')),
  entitlement_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(entitlement_capabilities) = 'array'),
  entitlement_limits jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(entitlement_limits) = 'object'),
  created_by_principal_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  delivery_state text NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sent', 'failed')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivered_at timestamptz,
  delivery_error_code text,
  consumed_at timestamptz,
  consumed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_tenant_id uuid REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  redeemed_session_id uuid REFERENCES exomem_sessions(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  CHECK (octet_length(token_digest) = 32),
  CHECK (octet_length(created_by_principal_digest) = 32),
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_at IS NULL AND consumed_by_user_id IS NULL AND redeemed_tenant_id IS NULL AND redeemed_session_id IS NULL)
    OR
    (consumed_at IS NOT NULL AND consumed_by_user_id IS NOT NULL AND redeemed_tenant_id IS NOT NULL AND redeemed_session_id IS NOT NULL)
  ),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX exomem_invites_email_created_idx
  ON exomem_invites (email_normalized, created_at DESC);

CREATE INDEX exomem_invites_valid_idx
  ON exomem_invites (expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE exomem_lifecycle_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  cell_id uuid REFERENCES exomem_cells(id) ON DELETE SET NULL,
  expected_previous_cell_id uuid REFERENCES exomem_cells(id) ON DELETE SET NULL,
  operation_type text NOT NULL
    CHECK (operation_type IN (
      'provision', 'suspend', 'resume', 'rotate_credential', 'export',
      'restore', 'stop', 'seal', 'delete'
    )),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'waiting', 'succeeded', 'failed_retryable', 'failed_terminal')),
  idempotency_key text NOT NULL,
  checkpoint text NOT NULL DEFAULT 'created',
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text,
  provider_result_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, operation_type, idempotency_key),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX exomem_lifecycle_operations_runnable_idx
  ON exomem_lifecycle_operations (next_attempt_at, created_at)
  WHERE state IN ('pending', 'failed_retryable', 'waiting');

CREATE INDEX exomem_lifecycle_operations_lease_idx
  ON exomem_lifecycle_operations (lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE TABLE exomem_transfer_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_digest bytea NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE CASCADE,
  cell_id uuid NOT NULL REFERENCES exomem_cells(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal_scope_digest bytea NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upload', 'download')),
  audience text NOT NULL CHECK (audience = 'exomem-hosted-transfer'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  outcome_code text,
  byte_limit bigint CHECK (byte_limit IS NULL OR byte_limit > 0),
  CHECK (octet_length(grant_digest) = 32),
  CHECK (octet_length(principal_scope_digest) = 32),
  CHECK (expires_at > issued_at)
);

CREATE INDEX exomem_transfer_grants_tenant_expiry_idx
  ON exomem_transfer_grants (tenant_id, expires_at);

CREATE TABLE exomem_paddle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paddle_event_id text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'live')),
  event_type text NOT NULL,
  tenant_id uuid REFERENCES exomem_tenants(id) ON DELETE SET NULL,
  source_revision text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  disposition text NOT NULL DEFAULT 'received'
    CHECK (disposition IN ('received', 'applied', 'duplicate', 'stale', 'rejected')),
  error_code text
);

CREATE INDEX exomem_paddle_events_tenant_occurred_idx
  ON exomem_paddle_events (tenant_id, occurred_at DESC);

CREATE TABLE exomem_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied', 'pending')),
  tenant_id uuid,
  cell_id uuid,
  operation_id uuid,
  request_id uuid,
  principal_scope_digest bytea,
  protocol_version text,
  release_version text,
  error_code text,
  duration_bucket text,
  byte_bucket text,
  count_bucket text,
  CHECK (
    principal_scope_digest IS NULL
    OR octet_length(principal_scope_digest) = 32
  )
);

CREATE INDEX exomem_audit_events_tenant_occurred_idx
  ON exomem_audit_events (tenant_id, occurred_at DESC);

CREATE INDEX exomem_audit_events_request_idx
  ON exomem_audit_events (request_id)
  WHERE request_id IS NOT NULL;
