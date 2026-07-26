-- One lifecycle operation owns at most one durable capacity allocation.
CREATE UNIQUE INDEX exomem_capacity_allocations_operation_id_idx
  ON exomem_capacity_allocations (operation_id)
  WHERE operation_id IS NOT NULL;

-- A provision claim must describe the allocation's exact pool and operation.
ALTER TABLE exomem_capacity_allocations
  ADD CONSTRAINT exomem_capacity_allocations_id_pool_operation_key
  UNIQUE (id, pool_id, operation_id);

ALTER TABLE exomem_capacity_claims
  ADD CONSTRAINT exomem_capacity_claims_allocation_pool_operation_fkey
  FOREIGN KEY (allocation_id, pool_id, operation_id)
  REFERENCES exomem_capacity_allocations (id, pool_id, operation_id)
  ON DELETE RESTRICT;
