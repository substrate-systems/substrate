-- Persist the exact export expiry and whether provider contact may have begun.
-- The nullable expiry preserves rolling-upgrade compatibility: an older
-- quiesced operation is recovered with its original `:quiesced` identity.

ALTER TABLE exomem_lifecycle_operations
  ADD COLUMN export_expires_at timestamptz,
  ADD COLUMN export_request_started boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT exomem_lifecycle_export_request_intent_check
    CHECK (
      (
        operation_type = 'export'
        AND (NOT export_request_started OR export_expires_at IS NOT NULL)
      )
      OR
      (
        operation_type <> 'export'
        AND export_expires_at IS NULL
        AND NOT export_request_started
      )
    );
