-- Exomem automate-cell-storage-deletion D1/D4: the signed deletion grant and
-- the stop time of a deleted cell.
--
-- When Substrate sets a cell's desired_state to 'deleted' it signs a deletion
-- grant (cloud-deletion-grants.ts) and stores it in `deletion_grant`.
-- cellctl's table SELECT reads the column and relays the grant to the purge
-- executors; scripts/exomem-cloud-grants.sql gives it no write, and gives
-- substrate_app the only write. `deletion_stopped_at` records when cellctl's
-- report that the cell is deleted first lands, set only by the trigger below
-- with the database clock; nobody holds a write on it.
--
-- Two guards keep the column honest:
--   * the CHECK keeps purge authority off every live cell;
--   * the finality trigger refuses any change to a deleted cell's desired
--     state, for every role, so a deletion is never reversed (D1). A DELETE
--     of the row itself stays allowed. The same trigger also refuses to
--     replace or clear a stored grant: a replaced grant could move
--     purge_after earlier, and a cleared grant stops the executors. It costs
--     nothing when it fires wrongly, because a grant is signed once and key
--     rotation pins both keys rather than re-signing.

ALTER TABLE exomem_cloud_cells ADD COLUMN deletion_grant text;
ALTER TABLE exomem_cloud_cells ADD COLUMN deletion_stopped_at timestamptz;

ALTER TABLE exomem_cloud_cells
  ADD CONSTRAINT exomem_cloud_cells_deletion_grant_only_when_deleted
  CHECK (deletion_grant IS NULL OR desired_state = 'deleted');

CREATE FUNCTION exomem_cloud_cells_deletion_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.desired_state = 'deleted' AND NEW.desired_state IS DISTINCT FROM 'deleted' THEN
    RAISE EXCEPTION 'a deleted exomem_cloud_cells row stays deleted';
  END IF;
  IF OLD.deletion_grant IS NOT NULL AND NEW.deletion_grant IS DISTINCT FROM OLD.deletion_grant THEN
    RAISE EXCEPTION 'a stored deletion grant is write-once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER exomem_cloud_cells_deletion_final_trigger
BEFORE UPDATE ON exomem_cloud_cells
FOR EACH ROW EXECUTE FUNCTION exomem_cloud_cells_deletion_final();


-- The stop time is the first UPDATE that reports the cell deleted on both
-- sides. A BEFORE trigger's writes to NEW bypass column privileges, as the
-- 0056 touch trigger already relies on, so cellctl's observed-only write can
-- land it while holding no grant on the column.
CREATE FUNCTION exomem_cloud_cells_deletion_stopped() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.desired_state = 'deleted' AND NEW.observed_state = 'deleted'
     AND NEW.deletion_stopped_at IS NULL THEN
    NEW.deletion_stopped_at := now();
  END IF;
  RETURN NEW;
END;
$$;


CREATE TRIGGER exomem_cloud_cells_deletion_stopped_trigger
BEFORE UPDATE ON exomem_cloud_cells
FOR EACH ROW EXECUTE FUNCTION exomem_cloud_cells_deletion_stopped();

-- Rows already deleted on both sides have no reporting UPDATE left to land the
-- trigger on, so the migration records their stop time once, itself.
UPDATE exomem_cloud_cells
SET deletion_stopped_at = now()
WHERE desired_state = 'deleted' AND observed_state = 'deleted'
  AND deletion_stopped_at IS NULL;
