-- Track when each cell's authorization session was last renewed.
--
-- The attestation window is one hour and nothing renewed it, so a cell stopped
-- admitting mutations an hour after it was provisioned while continuing to
-- serve reads normally -- and once lapsed it could not recover, because
-- minting is fenced off for a cell that has served and the drain that would
-- renew it needs a runtime attestation an expired cell can no longer sign.
--
-- The column defaults to now() so the ALTER takes the fast-default path and
-- never rewrites the table.
--
-- now() is the right value only for a cell that has ALREADY lapsed: dating
-- those truthfully would make the sweep attempt a renewal that must fail, and
-- because a failed renewal never advances this column they would sit at the
-- head of the sweep's ORDER BY forever, starving cells that can still be saved.
--
-- It is the wrong value for a cell provisioned less than an hour ago, and
-- silently fatal for one provisioned 21 to 59 minutes ago: its window closes at
-- provision + 60, but now() moves its first renewal to migration + 40, which is
-- later. Those cells are alive and savable, and stamping them fresh kills them.
-- Backfill from created_at, which errs toward renewing earlier -- the safe
-- direction on a deadline that cannot be recovered.
ALTER TABLE exomem_cells
    ADD COLUMN IF NOT EXISTS authorization_renewed_at timestamptz NOT NULL DEFAULT now();

UPDATE exomem_cells
   SET authorization_renewed_at = created_at
 WHERE created_at > now() - interval '1 hour'
   AND authorization_renewed_at > created_at;

-- The sweep orders by this column and takes a bounded batch, so it reads a
-- narrow index rather than the whole table. Only a cell that is actually
-- serving is renewed: one still provisioning has a freshly minted window, and
-- one being quiesced, stopped or deleted is not going to outlive its own.
CREATE INDEX IF NOT EXISTS exomem_cells_authorization_renewal_due
    ON exomem_cells (authorization_renewed_at)
    WHERE lifecycle_state = 'active' AND desired_state = 'running';

-- The renewal itself is an ordinary lifecycle operation. Enqueuing it rather
-- than calling the provisioner straight from the cron reuses the reconciler's
-- request envelope -- service credential, operation id, fence generation -- and
-- its retry and lease handling, none of which a bare cron call would have.
ALTER TABLE exomem_lifecycle_operations
  DROP CONSTRAINT exomem_lifecycle_operations_operation_type_check;

ALTER TABLE exomem_lifecycle_operations
  ADD CONSTRAINT exomem_lifecycle_operations_operation_type_check
    CHECK (operation_type IN (
      'provision', 'suspend', 'resume', 'rotate_credential', 'export',
      'restore', 'rollforward', 'stop', 'seal', 'delete', 'renew_authorization'
    )),
  -- Renewal only ever targets an existing cell, and only over v2: the v1 wire
  -- corpus is the frozen rollback protocol and never gains an action.
  ADD CONSTRAINT exomem_lifecycle_renew_authorization_shape_check CHECK (
    operation_type <> 'renew_authorization'
    OR (
      provisioner_wire_protocol = 'exomem-cell-provisioner.v2'
      AND cell_id IS NOT NULL
      AND expected_previous_cell_id IS NULL
    )
  );

-- At most one renewal in flight per cell. The sweep runs every minute and a
-- renewal takes seconds, so without this a slow provisioner would queue a
-- backlog that all fires at once.
--
-- "In flight" means every state that is not terminal, not just pending and
-- running. A renewal advances to `waiting` between its two checkpoints, so a
-- narrower predicate leaves it invisible in exactly the gap where a second one
-- would be raised, and `failed_retryable` is still owed a run.
CREATE UNIQUE INDEX IF NOT EXISTS exomem_lifecycle_one_renewal_per_cell_idx
  ON exomem_lifecycle_operations (cell_id)
  WHERE operation_type = 'renew_authorization'
    AND state NOT IN ('succeeded', 'failed_terminal');
