-- Standard-mode content keys share one per-cell root. NULL roots are legacy rows.
ALTER TABLE exomem_cloud_cells
  ADD COLUMN cell_root_key_wrapped bytea,
  ADD COLUMN cell_root_key_version integer,
  ADD COLUMN content_keys_retired_at timestamptz,
  ADD COLUMN last_live_key_destroyed_at timestamptz,
  ADD COLUMN key_retention_sources jsonb,
  ADD COLUMN keys_expire_at timestamptz,
  ADD COLUMN custody_observation jsonb,
  ADD COLUMN relocation_target_storage_class text,
  ADD COLUMN relocation_old_volume_id text,
  ADD COLUMN relocation_accepted_at timestamptz,
  ADD CONSTRAINT exomem_cloud_cell_root_pair CHECK (
    (cell_root_key_wrapped IS NULL) = (cell_root_key_version IS NULL)
  ),
  ADD CONSTRAINT exomem_cloud_cell_root_version CHECK (cell_root_key_version > 0),
  ADD CONSTRAINT exomem_cloud_retired_content_keys CHECK (
    content_keys_retired_at IS NULL OR (cell_root_key_wrapped IS NULL AND backup_key_wrapped IS NULL)
  ),
  ADD CONSTRAINT exomem_cloud_key_expiry_evidence CHECK (
    keys_expire_at IS NULL OR (last_live_key_destroyed_at IS NOT NULL AND key_retention_sources IS NOT NULL)
  );

-- A completed object stays private while the cell image verifies its exact version.
ALTER TABLE exomem_cloud_exports ADD COLUMN packing_report jsonb;
