-- Persist the outer provisioner wire contract independently from the existing
-- runtime target snapshot. Legacy operations remain permanently v1-compatible.

ALTER TABLE exomem_lifecycle_operations
  ADD COLUMN provisioner_wire_protocol text;

UPDATE exomem_lifecycle_operations
SET provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
WHERE provisioner_wire_protocol IS NULL;

ALTER TABLE exomem_lifecycle_operations
  ALTER COLUMN provisioner_wire_protocol SET DEFAULT 'exomem-cell-provisioner.v1',
  ALTER COLUMN provisioner_wire_protocol SET NOT NULL,
  ADD CONSTRAINT exomem_lifecycle_provisioner_wire_protocol_check CHECK (
    provisioner_wire_protocol IN (
      'exomem-cell-provisioner.v1',
      'exomem-cell-provisioner.v2'
    )
  ),
  ADD CONSTRAINT exomem_lifecycle_v2_target_check CHECK (
    provisioner_wire_protocol <> 'exomem-cell-provisioner.v2'
    OR target_candidate_id IS NOT NULL
    OR (
      operation_type = 'delete'
      AND cell_id IS NULL
      AND expected_previous_cell_id IS NULL
      AND target_candidate_id IS NULL
      AND target_assignment_id IS NULL
      AND target_assignment_generation IS NULL
      AND target_source_release IS NULL
      AND target_protocol_version IS NULL
      AND target_gateway_contract_digest IS NULL
      AND target_command_fingerprint IS NULL
      AND target_schema_digest IS NULL
      AND target_compatibility_digest IS NULL
    )
  );

CREATE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.provisioner_wire_protocol IS DISTINCT FROM OLD.provisioner_wire_protocol THEN
    RAISE EXCEPTION 'provisioner wire protocol is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_lifecycle_provisioner_wire_protocol_immutable
BEFORE UPDATE ON exomem_lifecycle_operations
FOR EACH ROW EXECUTE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable();
