-- Migration 0096 (add-cloud-media-access) — the two storage figures of a cell with a media store.
-- Observed by cellctl from the cell's storage record (add-cloud-media-store task 4.9) and read
-- by Home. scripts/exomem-cloud-grants.sql gives exomem_cellctl UPDATE on exactly these four.
--
-- vault_used_bytes: volume bytes in use minus cached copies of stored originals, counted against
--   the volume size (filesystem_bytes). media_used_bytes: the owner media meter, each stored
--   original counted once, Trash included, counted against media_allowance_bytes (the chart
--   store policy's allowance, which only cellctl knows). used_bytes keeps its meaning: the
--   whole volume's use.
--
-- All four NULL: the cell has no media store, or has never reported; Home shows used_bytes as
-- before. media_usage_observed_at set with a figure NULL: that figure is unknown, never zero.
-- cellctl writes all four back to NULL when a cell's media store is turned off.
ALTER TABLE exomem_cloud_cells
  ADD COLUMN vault_used_bytes bigint,
  ADD COLUMN media_used_bytes bigint,
  ADD COLUMN media_allowance_bytes bigint,
  ADD COLUMN media_usage_observed_at timestamptz,
  -- A figure without the time it was read says nothing about when it was true. (A NULL figure
  -- passes the bounds below, so the same test covers every figure.)
  ADD CONSTRAINT exomem_cloud_cells_media_usage_check CHECK (
    (vault_used_bytes IS NULL AND media_used_bytes IS NULL AND media_allowance_bytes IS NULL)
    OR media_usage_observed_at IS NOT NULL
  ),
  ADD CONSTRAINT exomem_cloud_cells_media_usage_bounds_check CHECK (
    vault_used_bytes >= 0 AND media_used_bytes >= 0 AND media_allowance_bytes >= 0
  );
