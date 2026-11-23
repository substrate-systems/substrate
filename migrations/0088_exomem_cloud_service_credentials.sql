-- Migration 0088 — Exomem Cloud service credentials (tenant-scoped).
--
-- A product backend reaches its tenant's Cloud cell with one long-lived
-- secret instead of the 15-minute OAuth tokens (change
-- add-cloud-service-credentials, design D1/D2/D5). The table stores only the
-- secret's SHA-256 digest; the secret itself appears once, in the issue
-- response, and is never recoverable afterwards.
--
-- Additive only: no existing table changes, and the one function body is a
-- single SELECT — the repository migration runner splits on semicolons.

CREATE TABLE exomem_cloud_service_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, as on exomem_cloud_cells: a tenant row must never disappear
  -- out from under a credential the gateway may still resolve.
  tenant_id uuid NOT NULL REFERENCES exomem_tenants(id) ON DELETE RESTRICT,
  -- The product principal the origin proof names, e.g. service:creator-platform.
  -- A format check on an identifier, not a list of products (design D7).
  principal text NOT NULL
    CHECK (principal ~ '^service:[a-z][a-z0-9-]{0,39}$'),
  -- SHA-256 of the `exs_` secret; the plaintext is never stored.
  secret_digest bytea NOT NULL UNIQUE,
  created_by_principal_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_principal_digest bytea,
  CHECK (octet_length(secret_digest) = 32),
  CHECK (octet_length(created_by_principal_digest) = 32),
  CHECK (
    revoked_by_principal_digest IS NULL
    OR octet_length(revoked_by_principal_digest) = 32
  )
);

-- Design D5: at most two live credentials per tenant and principal, enforced
-- by the issue transaction's tenant-row lock and count. This index makes the
-- live set and its count cheap to read; it is deliberately not a UNIQUE
-- index — two live credentials is the rotation state, not a constraint
-- violation.
CREATE INDEX exomem_cloud_service_credentials_live_idx
  ON exomem_cloud_service_credentials (tenant_id, principal)
  WHERE revoked_at IS NULL;

-- Operator lists order a tenant's credentials by creation time.
CREATE INDEX exomem_cloud_service_credentials_tenant_created_idx
  ON exomem_cloud_service_credentials (tenant_id, created_at);

-- Review B1: the tenant-access predicate the gateway's OAuth and service
-- credential lookups share — the tenant is not leaving and its owner has no
-- account block. One SQL function keeps the two lookups in step where a copied
-- fragment could drift; the cell's `desired_state <> 'deleted'` predicate stays
-- inline in each caller, beside the partial-unique-index predicate it pairs
-- with. SECURITY INVOKER by default, so callers read only the columns their
-- own role already holds.
CREATE FUNCTION exomem_cloud_tenant_access_allowed(target_tenant uuid, target_owner uuid)
RETURNS boolean LANGUAGE sql STABLE AS $function$
  SELECT EXISTS (
    SELECT 1 FROM exomem_tenants AS tenant
    WHERE tenant.id = target_tenant
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = tenant.id AND block.owner_user_id = target_owner
      )
  )
$function$;
