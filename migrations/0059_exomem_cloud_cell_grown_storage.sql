-- Migration 0059 — the size cellctl grew a local cell's volume to.
--
-- move-cloud-cells-to-local-storage D10 (Exomem): cellctl grows a cell on
-- local storage online, one default cell size at a time, when its hourly
-- backup finds the filesystem past 80% use. It records the grown size here and
-- renders the cell's claim at the larger of this and storage_gib, so a later
-- pass never renders a smaller claim, which Kubernetes refuses. Null until the
-- cell first grows. storage_gib stays Substrate's requested size.
--
-- cellctl's own column: scripts/exomem-cloud-grants.sql lets exomem_cellctl,
-- and no other role, update it. It is not a desired column, so a write
-- neither bumps generation nor notifies cellctl.

ALTER TABLE exomem_cloud_cells
  ADD COLUMN grown_storage_gib int CHECK (grown_storage_gib IS NULL OR grown_storage_gib > 0);
