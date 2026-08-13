-- Widen the immutable v1 provenance introduced by migration 0039. Existing
-- operations retain their stored protocol; new v2 work must carry its target.

ALTER TABLE exomem_lifecycle_operations
  DROP CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check;

ALTER TABLE exomem_lifecycle_operations
  ADD CONSTRAINT exomem_lifecycle_operations_provisioner_wire_protocol_check
    CHECK (
      provisioner_wire_protocol IN (
        'exomem-cell-provisioner.v1',
        'exomem-cell-provisioner.v2'
      )
    ),
  ADD CONSTRAINT exomem_lifecycle_v2_target_check CHECK (
    provisioner_wire_protocol <> 'exomem-cell-provisioner.v2'
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
    OR (
      target_candidate_id IS NOT NULL
      AND NOT (
        operation_type = 'delete'
        AND cell_id IS NULL
        AND expected_previous_cell_id IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.provisioner_wire_protocol IS DISTINCT FROM OLD.provisioner_wire_protocol THEN
    RAISE EXCEPTION 'provisioner wire protocol is immutable';
  END IF;
  IF OLD.provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
     AND (
       NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.fence_generation IS DISTINCT FROM OLD.fence_generation
       OR NEW.cell_id IS DISTINCT FROM OLD.cell_id
       OR NEW.expected_previous_cell_id IS DISTINCT FROM OLD.expected_previous_cell_id
       OR NEW.provisioner_wire_protocol IS DISTINCT FROM OLD.provisioner_wire_protocol
       OR NEW.target_candidate_id IS DISTINCT FROM OLD.target_candidate_id
       OR NEW.target_assignment_id IS DISTINCT FROM OLD.target_assignment_id
       OR NEW.target_assignment_generation IS DISTINCT FROM OLD.target_assignment_generation
       OR NEW.target_source_release IS DISTINCT FROM OLD.target_source_release
       OR NEW.target_protocol_version IS DISTINCT FROM OLD.target_protocol_version
       OR NEW.target_gateway_contract_digest IS DISTINCT FROM OLD.target_gateway_contract_digest
       OR NEW.target_command_fingerprint IS DISTINCT FROM OLD.target_command_fingerprint
       OR NEW.target_schema_digest IS DISTINCT FROM OLD.target_schema_digest
       OR NEW.target_compatibility_digest IS DISTINCT FROM OLD.target_compatibility_digest
     ) THEN
    RAISE EXCEPTION 'v2 lifecycle identity is immutable';
  END IF;
  RETURN NEW;
END
$function$;
