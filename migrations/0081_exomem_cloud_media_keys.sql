-- Exomem add-cloud-media-store D5: a cell's media key bundle, wrapped under its cell root key.
-- Both columns stay NULL until cellctl mints a bundle for a cell that the media edge serves.
-- scripts/exomem-cloud-grants.sql gives exomem_cellctl UPDATE on them.
ALTER TABLE exomem_cloud_cells
  ADD COLUMN media_key_wrapped bytea,
  ADD COLUMN media_key_version integer;
