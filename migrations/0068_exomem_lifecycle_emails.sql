-- Migration 0068 — Exomem account lifecycle emails.
--
-- The email outbox (0063) gains the kinds that announce the account's
-- lifecycle: ready (email 03), payment_failed (04), subscription_ended (05),
-- deletion_reminder (06) and deleted (07).
--
-- THE KIND LIST. Each kind has one renderer in code, so the set is fixed by
-- code. Every migration that adds kinds replaces this one constraint with the
-- full list: this list is the union of 0063's kinds and this change's.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox
  ADD CONSTRAINT exomem_email_outbox_kind_check
  CHECK (kind IN (
    'start', 'place_opened', 'waitlist', 'hold_reminder',
    'ready', 'payment_failed', 'subscription_ended', 'deletion_reminder', 'deleted'
  ));

-- THE EMAIL 03 CUTOFF. Email 03 ("Your Exomem is ready") is keyed by the cell
-- ('ready:' || cell_id) and sent the first time a cell is ready. A cell that
-- already exists when this ships and is past its unpaid hold has started for
-- its owner before, so it must not be welcomed again on deploy. Each such cell
-- gets a settled row under its key, so the ready sweep never enqueues one for
-- it. The row holds no address and no payload: it records only that email 03
-- was never sent for that cell. A cell still in its unpaid hold (a Paddle
-- entitlement still awaiting its first payment) gets no row, and receives
-- email 03 the first time it is ready after payment.
INSERT INTO exomem_email_outbox (kind, dedupe_key, state, last_error_code)
SELECT 'ready', 'ready:' || cell.cell_id, 'cancelled', 'EMAIL_PREDATES_TRIGGER'
FROM exomem_cloud_cells AS cell
JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
WHERE cell.desired_state <> 'deleted'
  -- The pre-payment states, as FIRST_PAYMENT_SOURCE_STATES (entitlements.ts)
  -- lists them when this migration ships.
  AND NOT (
    entitlement.source = 'paddle'
    AND entitlement.source_state IN ('awaiting_checkout', 'checkout_pending')
  )
ON CONFLICT (dedupe_key) DO NOTHING;
