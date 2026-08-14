-- Preserve the immutable v2 target while permitting the existing provision /
-- restore transaction to attach its operation-owned candidate exactly once.

CREATE OR REPLACE FUNCTION exomem_lifecycle_provisioner_wire_protocol_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.provisioner_wire_protocol IS DISTINCT FROM OLD.provisioner_wire_protocol THEN
    RAISE EXCEPTION 'provisioner wire protocol is immutable';
  END IF;

  IF OLD.provisioner_wire_protocol = 'exomem-cell-provisioner.v2' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.fence_generation IS DISTINCT FROM OLD.fence_generation
       OR NEW.target_candidate_id IS DISTINCT FROM OLD.target_candidate_id
       OR NEW.target_assignment_id IS DISTINCT FROM OLD.target_assignment_id
       OR NEW.target_assignment_generation IS DISTINCT FROM OLD.target_assignment_generation
       OR NEW.target_source_release IS DISTINCT FROM OLD.target_source_release
       OR NEW.target_protocol_version IS DISTINCT FROM OLD.target_protocol_version
       OR NEW.target_gateway_contract_digest IS DISTINCT FROM OLD.target_gateway_contract_digest
       OR NEW.target_command_fingerprint IS DISTINCT FROM OLD.target_command_fingerprint
       OR NEW.target_schema_digest IS DISTINCT FROM OLD.target_schema_digest
       OR NEW.target_compatibility_digest IS DISTINCT FROM OLD.target_compatibility_digest THEN
      RAISE EXCEPTION 'v2 lifecycle identity is immutable';
    END IF;

    IF NEW.cell_id IS DISTINCT FROM OLD.cell_id
       OR NEW.expected_previous_cell_id IS DISTINCT FROM OLD.expected_previous_cell_id THEN
      IF NOT (
        OLD.operation_type IN ('provision', 'restore')
        AND OLD.state = 'running'
        AND NEW.state = 'running'
        AND OLD.checkpoint = 'created'
        AND NEW.checkpoint = 'created'
        AND OLD.lease_owner IS NOT NULL
        AND NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
        AND OLD.lease_expires_at > now()
        AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
        AND OLD.cell_id IS NULL
        AND NEW.cell_id IS NOT NULL
        AND (
          NEW.expected_previous_cell_id IS NOT DISTINCT FROM OLD.expected_previous_cell_id
          OR (
            OLD.expected_previous_cell_id IS NULL
            AND NEW.expected_previous_cell_id IS NOT NULL
          )
        )
        AND NEW.cell_id IS DISTINCT FROM NEW.expected_previous_cell_id
        AND EXISTS (
          SELECT 1
          FROM exomem_tenants AS tenant
          JOIN exomem_cells AS candidate
            ON candidate.id = NEW.cell_id
           AND candidate.tenant_id = tenant.id
          WHERE tenant.id = NEW.tenant_id
            AND tenant.fence_generation = NEW.fence_generation
            AND tenant.desired_state <> 'deleted'
            AND candidate.routing_state = 'unbound'
            AND candidate.lifecycle_state = CASE OLD.operation_type
              WHEN 'provision' THEN 'provisioning'
              WHEN 'restore' THEN 'restoring'
            END
            AND candidate.desired_state = 'running'
            AND candidate.release_version = NEW.target_source_release
            AND candidate.protocol_version = NEW.target_protocol_version
            AND candidate.provider_ref IS NULL
            AND candidate.private_endpoint_ciphertext IS NULL
            AND candidate.service_credential_ciphertext IS NOT NULL
            AND octet_length(candidate.service_credential_digest) = 32
            AND candidate.created_at = transaction_timestamp()
            AND candidate.updated_at = transaction_timestamp()
            AND NOT EXISTS (
              SELECT 1
              FROM exomem_lifecycle_operations AS other_operation
              WHERE other_operation.id <> OLD.id
                AND other_operation.cell_id = candidate.id
            )
            AND (
              NEW.expected_previous_cell_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM exomem_cells AS prior
                WHERE prior.id = NEW.expected_previous_cell_id
                  AND prior.tenant_id = tenant.id
              )
            )
            AND NEW.expected_previous_cell_id IS NOT DISTINCT FROM
                COALESCE(OLD.expected_previous_cell_id, tenant.bound_cell_id)
        )
      ) THEN
        RAISE EXCEPTION 'v2 lifecycle identity is immutable';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
