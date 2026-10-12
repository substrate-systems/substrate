-- Migration 0068 — Exomem account lifecycle emails.
--
-- The email outbox (0063) gains the kinds that announce the account's
-- lifecycle: ready (email 03), payment_failed (04), subscription_ended (05),
-- deletion_reminder (06) and deleted (07).
--
-- THE KIND LIST. Each kind has one renderer in code, so the set is fixed by
-- code. Every migration that adds kinds replaces this one constraint with the
-- full list: this list is the union of 0063's kinds, 0065's invitation kinds
-- and this change's. A Postgres test compares it with the code's registry.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox
  ADD CONSTRAINT exomem_email_outbox_kind_check
  CHECK (kind IN (
    'start', 'place_opened', 'waitlist', 'hold_reminder',
    'invitation', 'friend_invitation', 'covered_invitation',
    'invitation_reminder', 'invitation_used', 'invitation_ended',
    'ready', 'payment_failed', 'subscription_ended', 'deletion_reminder', 'deleted'
  ));

-- THE ACCOUNT AN EMAIL IS ABOUT. An account email belongs to its tenant, not
-- to the address it was first queued for: the owner's address can change
-- before it is sent. Account deletion removes every row of the tenant, at
-- whatever address, before it queues email 07. Start links, waitlist emails
-- and invitation emails belong to no tenant and keep this NULL.
ALTER TABLE exomem_email_outbox
  ADD COLUMN tenant_id uuid REFERENCES exomem_tenants(id) ON DELETE CASCADE;
CREATE INDEX exomem_email_outbox_tenant_idx
  ON exomem_email_outbox (tenant_id)
  WHERE tenant_id IS NOT NULL;

-- The only account email queued before this migration is the unpaid-hold
-- reminder, keyed 'hold-reminder:' || cell_id (cloud-admission.ts). Each one,
-- pending or settled, takes its cell's tenant, so account deletion removes it
-- too. Start link, waitlist and invitation rows keep NULL.
UPDATE exomem_email_outbox AS outbox
SET tenant_id = cell.tenant_id
FROM exomem_cloud_cells AS cell
WHERE outbox.kind = 'hold_reminder'
  AND outbox.tenant_id IS NULL
  AND outbox.dedupe_key = 'hold-reminder:' || cell.cell_id;

-- THE CONTROLLER'S DELETION, defined once. cellctl has deleted a cell, with
-- its volume, backups and keys, once it reports the cell deleted at the
-- current generation. Capacity (cloud-capacity.ts) counts every other cell as
-- live, and email 07 (email-outbox.ts) waits for it. A function, not a view:
-- the schema-wide grants give the app role writes on every view, and an
-- updatable view of exomem_cloud_cells would apply them as its owner.
CREATE FUNCTION exomem_cloud_cell_deletion_finished(cell exomem_cloud_cells)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $function$
  SELECT cell.desired_state = 'deleted'
    AND cell.observed_state IS NOT DISTINCT FROM 'deleted'
    AND cell.observed_generation IS NOT DISTINCT FROM cell.generation
$function$;

COMMENT ON FUNCTION exomem_cloud_cell_deletion_finished(exomem_cloud_cells) IS
  'cellctl has deleted this cell, with its volume, backups and keys: it reports '
  'the cell deleted at its current generation. cellctl then stops observing the '
  'row, so its observed_at stays the time of that report.';

-- THE EMAIL 03 CUTOFF. Email 03 ("Your Exomem is ready") is keyed by the cell
-- ('ready:' || cell_id) and sent the first time a cell is ready. A live cell
-- that shows it has started when this ships must not be welcomed on deploy:
-- it is ready now, or cellctl last saw it running or read-only. Each such
-- cell gets a settled row under its key, so the ready sweep never enqueues
-- one for it. The row holds no address and no payload: it records only that
-- email 03 was never sent for that cell. Every other cell, one never seen
-- running, gets no row and receives email 03 the first time it is ready. The
-- columns keep no history, so a cell that ran once but is stopped when this
-- ships also gets email 03 when it next runs; that is the accepted cost of
-- never missing a real first start. A marketplace reviewer's tenant never
-- receives email 03, so its cells need no row.
INSERT INTO exomem_email_outbox (kind, dedupe_key, tenant_id, state, last_error_code)
SELECT 'ready', 'ready:' || cell.cell_id, cell.tenant_id, 'cancelled', 'EMAIL_PREDATES_TRIGGER'
FROM exomem_cloud_cells AS cell
JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
WHERE cell.desired_state <> 'deleted'
  AND NOT tenant.marketplace_reviewer_purpose
  AND (cell.ready OR cell.observed_state IN ('running', 'read_only'))
ON CONFLICT (dedupe_key) DO NOTHING;
