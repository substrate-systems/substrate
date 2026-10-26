-- C5 adds observed limits, an immutable storage request and the Job's staged counts.
ALTER TABLE exomem_cloud_cells
  ADD COLUMN import_limits jsonb CHECK (import_limits IS NULL OR jsonb_typeof(import_limits) = 'object');

ALTER TABLE exomem_cloud_imports
  ADD COLUMN required_storage_gib integer CHECK (required_storage_gib > 0),
  ADD COLUMN staged_files bigint CHECK (staged_files >= 0),
  ADD COLUMN staged_bytes bigint CHECK (staged_bytes >= 0),
  ADD CONSTRAINT exomem_cloud_imports_staged_counts_check
    CHECK ((staged_files IS NULL) = (staged_bytes IS NULL));

CREATE OR REPLACE FUNCTION exomem_cloud_imports_touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.import_id, NEW.cell_id, NEW.kind, NEW.declared_bytes, NEW.declared_files, NEW.required_storage_gib)
       IS DISTINCT FROM ROW(OLD.import_id, OLD.cell_id, OLD.kind, OLD.declared_bytes, OLD.declared_files, OLD.required_storage_gib)
       OR (OLD.ciphertext_sha256 IS NOT NULL AND
         ROW(NEW.ciphertext_sha256, NEW.ciphertext_bytes) IS DISTINCT FROM
         ROW(OLD.ciphertext_sha256, OLD.ciphertext_bytes))
       OR (OLD.part_etags IS NOT NULL AND NEW.part_etags IS DISTINCT FROM OLD.part_etags)
       OR (OLD.staged_files IS NOT NULL AND
         ROW(NEW.staged_files, NEW.staged_bytes) IS DISTINCT FROM
         ROW(OLD.staged_files, OLD.staged_bytes)) THEN
      RAISE EXCEPTION 'import request and accepted report are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_notify('exomem_cloud_cells', NEW.cell_id);
  ELSIF ROW(NEW.requested_state, NEW.ciphertext_sha256, NEW.ciphertext_bytes, NEW.part_etags)
        IS DISTINCT FROM ROW(OLD.requested_state, OLD.ciphertext_sha256, OLD.ciphertext_bytes, OLD.part_etags) THEN
    PERFORM pg_notify('exomem_cloud_cells', NEW.cell_id);
  END IF;
  RETURN NEW;
END;
$$;
