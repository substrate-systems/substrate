-- Durable Exomem Hosted capacity ledger. Additive and deliberately conservative.
-- Existing tenants are backfilled as occupied; migrations never contact a provider.

CREATE TABLE exomem_capacity_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_key text NOT NULL UNIQUE,
  storage_bytes bigint NOT NULL CHECK (storage_bytes > 0),
  runtime_slots integer NOT NULL CHECK (runtime_slots >= 0),
  provision_slots integer NOT NULL CHECK (provision_slots >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO exomem_capacity_pools (pool_key, storage_bytes, runtime_slots, provision_slots)
VALUES ('exomem-hosted-alpha', 5368709120, 0, 0)
ON CONFLICT (pool_key) DO NOTHING;

CREATE TABLE exomem_capacity_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES exomem_capacity_pools(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL UNIQUE REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  storage_bytes bigint NOT NULL CHECK (storage_bytes > 0),
  runtime_slots integer NOT NULL CHECK (runtime_slots >= 0),
  provision_slots integer NOT NULL CHECK (provision_slots >= 0),
  state text NOT NULL CHECK (state IN ('reserved', 'occupied', 'uncertain', 'released', 'retained_storage')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  occupied_at timestamptz,
  released_at timestamptz,
  operation_id uuid REFERENCES exomem_lifecycle_operations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'released') = (released_at IS NOT NULL))
);

CREATE INDEX exomem_capacity_allocations_pool_state_idx
  ON exomem_capacity_allocations (pool_id, state);

CREATE TABLE exomem_capacity_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES exomem_capacity_pools(id) ON DELETE RESTRICT,
  allocation_id uuid NOT NULL UNIQUE REFERENCES exomem_capacity_allocations(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL UNIQUE REFERENCES exomem_lifecycle_operations(id) ON DELETE RESTRICT,
  claim_kind text NOT NULL CHECK (claim_kind IN ('initial_provision', 'resume')),
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lease_expires_at > created_at)
);

CREATE INDEX exomem_capacity_claims_expiry_idx
  ON exomem_capacity_claims (pool_id, lease_expires_at);

INSERT INTO exomem_capacity_allocations (
  pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state, occupied_at
)
SELECT pool.id, tenant.id, 5368709120, 1, 0, 'occupied', now()
FROM exomem_tenants AS tenant
CROSS JOIN exomem_capacity_pools AS pool
WHERE pool.pool_key = 'exomem-hosted-alpha'
ON CONFLICT (tenant_id) DO NOTHING;
