-- The component enum is the closed functional-health protocol, not customer vocabulary.
CREATE TABLE exomem_health_proofs (
  component text PRIMARY KEY CHECK (component IN ('control', 'email', 'memory')),
  run_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  success boolean NOT NULL,
  CHECK (started_at <= checked_at)
);

-- The runner gets EXECUTE on this function, never a table grant or a caller-chosen component.
DO $migration$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION %1$I.exomem_record_memory_health_proof(
      attempt_id uuid, attempt_started_at timestamptz,
      attempt_checked_at timestamptz, attempt_success boolean
    ) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF attempt_id IS NULL OR attempt_started_at IS NULL OR attempt_checked_at IS NULL
         OR attempt_success IS NULL OR NOT isfinite(attempt_started_at)
         OR NOT isfinite(attempt_checked_at) OR attempt_started_at > attempt_checked_at
         OR attempt_checked_at > clock_timestamp() THEN
        RAISE EXCEPTION 'INVALID_HEALTH_PROOF' USING ERRCODE = '22023';
      END IF;
      INSERT INTO %1$I.exomem_health_proofs AS proof
        (component, run_id, started_at, checked_at, success)
      VALUES ('memory', attempt_id, attempt_started_at, attempt_checked_at, attempt_success)
      ON CONFLICT (component) DO UPDATE SET
        run_id = EXCLUDED.run_id, started_at = EXCLUDED.started_at,
        checked_at = EXCLUDED.checked_at, success = EXCLUDED.success
      WHERE EXCLUDED.started_at > proof.started_at;
    END;
    $body$;
  $definition$, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.exomem_record_memory_health_proof(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC',
    target_schema
  );
END;
$migration$;
