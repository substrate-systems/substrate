-- Track when each cell's authorization session was last renewed.
--
-- The attestation window is one hour and nothing renewed it, so a cell stopped
-- admitting mutations an hour after it was provisioned while continuing to
-- serve reads normally -- and once lapsed it could not recover, because
-- minting is fenced off for a cell that has served and the drain that would
-- renew it needs a runtime attestation an expired cell can no longer sign.
--
-- Existing rows default to now() rather than to their creation time. A cell
-- provisioned before this migration has already lapsed and cannot be renewed,
-- so dating it truthfully would make the sweep attempt a renewal that must
-- fail; treating it as fresh lets it fall out of the fleet on its own terms.
ALTER TABLE exomem_cells
    ADD COLUMN IF NOT EXISTS authorization_renewed_at timestamptz NOT NULL DEFAULT now();

-- The sweep orders by this column and takes a bounded batch, so it reads a
-- narrow index rather than the whole table. Only a cell that is actually
-- serving is renewed: one still provisioning has a freshly minted window, and
-- one being quiesced, stopped or deleted is not going to outlive its own.
CREATE INDEX IF NOT EXISTS exomem_cells_authorization_renewal_due
    ON exomem_cells (authorization_renewed_at)
    WHERE lifecycle_state = 'active' AND desired_state = 'running';
