-- Migration 0064 — the account facts Home and the web journey show.
--
-- Every tenant gets a support reference that support staff can look up
-- (shown as EX-XXXX). Every Paddle entitlement stores the subscription facts
-- Paddle reports (price, next payment, discount, scheduled change) and the
-- start of its current past_due period.

ALTER TABLE exomem_tenants
  ADD COLUMN support_reference text,
  ADD CONSTRAINT exomem_tenants_support_reference_format
    CHECK (support_reference ~ '^[0-9A-HJKMNP-TV-Z]{4,8}$'),
  ADD CONSTRAINT exomem_tenants_support_reference_key UNIQUE (support_reference);

-- Draws 4 random Crockford base32 characters (no I, L, O or U). A drawn
-- value that a tenant already holds is drawn again, and every fourth miss
-- adds a character, so the column default never fails on a collision. The
-- UNIQUE constraint stays the guarantee for two concurrent inserts.
CREATE FUNCTION exomem_new_support_reference() RETURNS text
LANGUAGE plpgsql VOLATILE AS $function$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  random_bytes bytea;
  candidate text;
BEGIN
  FOR attempt IN 0..15 LOOP
    random_bytes := gen_random_bytes(8);
    candidate := '';
    FOR char_index IN 0..(3 + attempt / 4) LOOP
      candidate := candidate || substr(alphabet, 1 + (get_byte(random_bytes, char_index) & 31), 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM exomem_tenants WHERE support_reference = candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'no free exomem support reference after 16 draws';
END
$function$;

-- One UPDATE per tenant, so each draw sees the references given before it.
DO $backfill$
DECLARE
  tenant_row record;
BEGIN
  FOR tenant_row IN SELECT id FROM exomem_tenants WHERE support_reference IS NULL ORDER BY created_at, id LOOP
    UPDATE exomem_tenants SET support_reference = exomem_new_support_reference() WHERE id = tenant_row.id;
  END LOOP;
END
$backfill$;

ALTER TABLE exomem_tenants
  ALTER COLUMN support_reference SET DEFAULT exomem_new_support_reference(),
  ALTER COLUMN support_reference SET NOT NULL;

-- Written by the Paddle event store from subscription events and
-- reconciliation only; NULL means Paddle has not reported the fact.
ALTER TABLE exomem_entitlements
  ADD COLUMN provider_price_id text,
  ADD COLUMN provider_price_name text,
  ADD COLUMN provider_next_billed_at timestamptz,
  ADD COLUMN provider_discount_id text,
  ADD COLUMN provider_scheduled_change_at timestamptz,
  ADD COLUMN grace_started_at timestamptz;

-- A subscription that is past_due now started its current period with its
-- latest subscription.past_due receipt. A stale receipt counts: it arrives
-- after a later subscription.updated, yet still dates the transition. A row
-- with no such receipt keeps NULL: its grace start is unknown, never guessed.
UPDATE exomem_entitlements AS entitlement
SET grace_started_at = receipt.started_at
FROM (
  SELECT tenant_id, max(occurred_at) AS started_at
  FROM exomem_paddle_events
  WHERE event_type = 'subscription.past_due'
    AND disposition IN ('applied', 'stale')
    AND tenant_id IS NOT NULL
  GROUP BY tenant_id
) AS receipt
WHERE entitlement.tenant_id = receipt.tenant_id
  AND entitlement.source = 'paddle'
  AND entitlement.source_state = 'past_due';
