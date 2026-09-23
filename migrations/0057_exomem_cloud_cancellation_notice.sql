-- Migration 0057 — Exomem Cloud cancellation notice dedupe column.
--
-- Item 5 / task 3.7 (`adopt-exomem-cloud-plain-cells`): a Cloud tenant whose
-- Paddle subscription becomes cancelled gets a one-time notice email stating
-- the read-only export window and the deletion date. Redelivery of the
-- triggering Paddle webhook must not send it twice, so the send is claimed
-- with the same atomic "UPDATE ... WHERE column IS NULL" idiom every other
-- one-time write in this schema already uses (e.g. exomem_invites.consumed_at).
--
-- Lives on exomem_cloud_cells rather than the shared exomem_entitlements
-- table: this is Cloud-only bookkeeping, and keeping it here needs no grant
-- changes beyond what scripts/exomem-cloud-grants.sql already gives
-- substrate_app on this table.

ALTER TABLE exomem_cloud_cells
  ADD COLUMN cancellation_notice_sent_at timestamptz;
