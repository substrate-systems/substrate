-- Migration 0072 — Exomem email schemes.
--
-- Every Exomem email is built on one base scheme, dark or light, and carries
-- the other in a prefers-color-scheme block. A client that ignores that block
-- (Gmail on the web) shows only the base, so the base follows the person's
-- theme on the Exomem site. These columns sit beside the time zones of 0063:
-- a redemption records the tenant's, a start request records a waitlist
-- entry's, and the outbox row keeps the one its email is rendered in.
--
-- The two values are the colour schemes of the CSS specification, so the set
-- is fixed. NULL means unknown, and the email is then dark, as every email was
-- before this migration.

ALTER TABLE exomem_tenants
  ADD COLUMN email_scheme text
    CHECK (email_scheme IS NULL OR email_scheme IN ('dark', 'light'));

ALTER TABLE exomem_waitlist_entries
  ADD COLUMN email_scheme text
    CHECK (email_scheme IS NULL OR email_scheme IN ('dark', 'light'));

-- Cleared with the recipient and their time zone 30 days after the row settles.
ALTER TABLE exomem_email_outbox
  ADD COLUMN recipient_email_scheme text
    CHECK (recipient_email_scheme IS NULL OR recipient_email_scheme IN ('dark', 'light'));
