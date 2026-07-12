-- Durable export release, restore pinning, and provider-object GC.
-- Existing exports remain valid; deleted tombstones are allowed to scrub all
-- provider references and integrity metadata after deletion is proven.

ALTER TABLE exomem_lifecycle_operations
  ADD COLUMN input_export_id uuid,
  ADD COLUMN export_release_reference_ciphertext jsonb,
  ADD COLUMN export_release_reference_digest bytea;

-- Legacy restores copied the encrypted provider reference and its unique digest
-- but predate the explicit export FK. Pin every active restore before GC can be
-- enabled. The 0017 digest uniqueness constraint makes more than one match
-- structurally impossible; the count guard and validated CHECK below also fail
-- closed for a missing or unexpectedly ambiguous source.
WITH legacy_restore_candidates AS (
  SELECT operation.id AS operation_id,
         min(export_row.id::text)::uuid AS export_id
  FROM exomem_lifecycle_operations AS operation
  JOIN exomem_exports AS export_row
    ON export_row.tenant_id = operation.tenant_id
   AND operation.input_reference_digest = export_row.storage_reference_digest
   AND export_row.state = 'available'
  WHERE operation.operation_type = 'restore'
    AND operation.state IN ('pending', 'running', 'waiting', 'failed_retryable')
    AND operation.input_export_id IS NULL
  GROUP BY operation.id
  HAVING count(*) = 1
)
UPDATE exomem_lifecycle_operations AS operation
SET input_export_id = candidate.export_id
FROM legacy_restore_candidates AS candidate
WHERE operation.id = candidate.operation_id;

ALTER TABLE exomem_lifecycle_operations
  ADD CONSTRAINT exomem_lifecycle_input_export_fk
    FOREIGN KEY (tenant_id, input_export_id)
    REFERENCES exomem_exports(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT exomem_lifecycle_input_export_scope_check
    CHECK (operation_type = 'restore' OR input_export_id IS NULL),
  ADD CONSTRAINT exomem_lifecycle_active_restore_export_pin_check
    CHECK (
      operation_type <> 'restore'
      OR state NOT IN ('pending', 'running', 'waiting', 'failed_retryable')
      OR input_export_id IS NOT NULL
    ),
  ADD CONSTRAINT exomem_lifecycle_export_release_check
    CHECK (
      (export_release_reference_ciphertext IS NULL AND export_release_reference_digest IS NULL)
      OR (
        operation_type = 'export'
        AND export_release_reference_ciphertext IS NOT NULL
        AND octet_length(export_release_reference_digest) = 32
      )
    );

CREATE INDEX exomem_lifecycle_restore_export_pin_idx
  ON exomem_lifecycle_operations (input_export_id, state)
  WHERE input_export_id IS NOT NULL;

ALTER TABLE exomem_exports
  DROP CONSTRAINT exomem_exports_storage_reference_digest_key,
  DROP CONSTRAINT exomem_exports_storage_reference_digest_check,
  DROP CONSTRAINT exomem_exports_archive_sha256_check,
  DROP CONSTRAINT exomem_exports_manifest_sha256_check,
  DROP CONSTRAINT exomem_exports_archive_size_check,
  DROP CONSTRAINT exomem_exports_check;

ALTER TABLE exomem_exports
  ALTER COLUMN storage_reference_digest DROP NOT NULL,
  ALTER COLUMN archive_sha256 DROP NOT NULL,
  ALTER COLUMN manifest_sha256 DROP NOT NULL,
  ALTER COLUMN archive_size DROP NOT NULL,
  ALTER COLUMN encryption_scheme DROP NOT NULL,
  ALTER COLUMN integrity_verified DROP NOT NULL,
  ADD COLUMN gc_lease_owner text,
  ADD COLUMN gc_lease_expires_at timestamptz,
  ADD COLUMN gc_attempts integer NOT NULL DEFAULT 0 CHECK (gc_attempts >= 0),
  ADD COLUMN gc_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN gc_error_code text,
  ADD COLUMN provider_deleted_at timestamptz,
  ADD CONSTRAINT exomem_exports_gc_lease_check
    CHECK ((gc_lease_owner IS NULL) = (gc_lease_expires_at IS NULL));

-- Under the 0017 lifecycle, `deleted` was written only after the provider had
-- proven full storage destruction. Preserve that proof time while converting
-- its retained integrity metadata into the stricter scrubbed tombstone shape.
UPDATE exomem_exports AS export_row
SET storage_reference_ciphertext = NULL,
    storage_reference_digest = NULL,
    archive_sha256 = NULL,
    manifest_sha256 = NULL,
    archive_size = NULL,
    encryption_scheme = NULL,
    integrity_verified = NULL,
    provider_deleted_at = export_row.deleted_at
WHERE export_row.state = 'deleted';

ALTER TABLE exomem_exports
  ADD CONSTRAINT exomem_exports_tombstone_check
    CHECK (
      (
        state = 'deleted'
        AND storage_reference_ciphertext IS NULL
        AND storage_reference_digest IS NULL
        AND archive_sha256 IS NULL
        AND manifest_sha256 IS NULL
        AND archive_size IS NULL
        AND encryption_scheme IS NULL
        AND integrity_verified IS NULL
        AND deleted_at IS NOT NULL
        AND provider_deleted_at IS NOT NULL
      )
      OR
      (
        state <> 'deleted'
        AND storage_reference_ciphertext IS NOT NULL
        AND octet_length(storage_reference_digest) = 32
        AND archive_sha256 ~ '^[0-9a-f]{64}$'
        AND manifest_sha256 ~ '^[0-9a-f]{64}$'
        AND archive_size > 0
        AND encryption_scheme = 'envelope-aes-256-gcm'
        AND integrity_verified
        AND deleted_at IS NULL
        AND provider_deleted_at IS NULL
      )
    );

CREATE UNIQUE INDEX exomem_exports_storage_reference_digest_unique_idx
  ON exomem_exports (storage_reference_digest)
  WHERE storage_reference_digest IS NOT NULL;

CREATE INDEX exomem_exports_gc_ready_idx
  ON exomem_exports (gc_next_attempt_at, expires_at, created_at)
  WHERE state IN ('available', 'deleting');
