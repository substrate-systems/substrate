-- Add the explicit same-cell runtime transition. This migration creates no operation,
-- assignment, tenant mutation, or release authority.

ALTER TABLE exomem_lifecycle_operations
  DROP CONSTRAINT exomem_lifecycle_operations_operation_type_check;

ALTER TABLE exomem_lifecycle_operations
  ADD CONSTRAINT exomem_lifecycle_operations_operation_type_check
    CHECK (operation_type IN (
      'provision', 'suspend', 'resume', 'rotate_credential', 'export',
      'restore', 'rollforward', 'stop', 'seal', 'delete'
    )),
  ADD CONSTRAINT exomem_lifecycle_rollforward_shape_check CHECK (
    operation_type <> 'rollforward'
    OR (
      provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
      AND cell_id IS NOT NULL
      AND expected_previous_cell_id IS NULL
      AND target_candidate_id IS NOT NULL
      AND target_assignment_id IS NOT NULL
      AND target_assignment_generation > 0
    )
  );

-- A recurring runtime upgrade needs the current assignment to remain active while the
-- next exact target is prepared. Activation retires the old generation atomically.
DROP INDEX exomem_agent_contract_rollout_assignments_one_current_idx;

CREATE UNIQUE INDEX exomem_agent_contract_rollout_assignments_one_preparing_idx
  ON exomem_agent_contract_rollout_assignments (tenant_id)
  WHERE state = 'preparing';

CREATE UNIQUE INDEX exomem_agent_contract_rollout_assignments_one_active_idx
  ON exomem_agent_contract_rollout_assignments (tenant_id)
  WHERE state = 'active';
