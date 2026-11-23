-- Migration 0090 — Exomem Cloud service notices.
--
-- The operator declares planned maintenance or an incident; nothing creates a
-- notice automatically. A notice drives two emails through the outbox and one
-- header the gateway sends to each covered cell. A notice has no state
-- column: its state follows from these times (service-notices.ts).
--
--   maintenance: scheduled from announce_from to starts_at, active until
--                ends_at, over afterwards or once cancelled;
--   incident:    active from starts_at until resolved_at.

CREATE TABLE exomem_service_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Each kind sends different emails and follows different rules, so the set
  -- is fixed by the specification, not by data.
  kind text NOT NULL CHECK (kind IN ('maintenance', 'incident')),
  -- The operator's own words. The email and the assistant's sentence quote it.
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 280),
  starts_at timestamptz NOT NULL,
  -- Maintenance only. An incident has no planned end.
  ends_at timestamptz,
  -- Maintenance only: when owners are first told. Defaults to 48 hours before
  -- the start in code, and is stored so the notice never moves.
  announce_from timestamptz,
  cancelled_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'maintenance') = (ends_at IS NOT NULL)),
  CHECK ((kind = 'maintenance') = (announce_from IS NOT NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (announce_from IS NULL OR announce_from <= starts_at),
  -- Only maintenance is cancelled and only an incident is resolved.
  CHECK (kind = 'maintenance' OR cancelled_at IS NULL),
  CHECK (kind = 'incident' OR resolved_at IS NULL),
  CHECK (resolved_at IS NULL OR resolved_at >= starts_at)
);

-- The gateway's one query and the fan-out's one query read only notices that
-- no one has cancelled or resolved. The set is a handful of rows.
CREATE INDEX exomem_service_notices_open_idx
  ON exomem_service_notices (starts_at)
  WHERE cancelled_at IS NULL AND resolved_at IS NULL;

-- The cells a notice names. A notice with no row here covers the whole fleet.
-- cell_id is deliberately not a foreign key: the lifecycle sweep deletes a
-- cell's row, and a cascade would delete the notice's row with it, which
-- turns a notice that named one cell into a notice that covers every cell. A
-- named cell that is gone matches nothing instead. The admin route checks that
-- each named cell exists when it creates the notice.
CREATE TABLE exomem_service_notice_cells (
  notice_id uuid NOT NULL REFERENCES exomem_service_notices (id) ON DELETE CASCADE,
  cell_id text NOT NULL CHECK (cell_id ~ '^[a-z2-7]{16}$'),
  PRIMARY KEY (notice_id, cell_id)
);

-- The tenants a notice covers: one row per tenant whose cell is not deleted
-- and whose owner has an email address, with the owner's address, zone and
-- scheme as the emails need them. An empty array covers the fleet; a
-- non-empty one names the cells. A marketplace reviewer's tenant is a review
-- fixture, not a person's Exomem, so it is never covered (email 03 skips it
-- the same way). `created_before` limits coverage to cells that existed by
-- then: an owner whose cell began after an incident was resolved never had the
-- problem, so the incident email passes the resolution time. Maintenance
-- passes infinity. The operator's preview count, the fan-out and the
-- send-time check all read this one definition. STABLE and one SELECT, so
-- PostgreSQL inlines it and pushes a `tenant_id =` filter into the scan.
CREATE FUNCTION exomem_service_notice_covered_tenants(
  cell_ids text[],
  created_before timestamptz DEFAULT 'infinity'
)
RETURNS TABLE (
  tenant_id uuid, cell_id text, owner_email text,
  time_zone text, email_scheme text, theme_choice text
)
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT tenant.id, cell.cell_id, owner.email::text,
         tenant.time_zone, tenant.email_scheme, tenant.theme_choice
  FROM exomem_cloud_cells AS cell
  JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
  JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
  WHERE cell.desired_state <> 'deleted'
    AND cell.created_at <= created_before
    AND tenant.status NOT IN ('deletion_pending', 'deleted')
    AND NOT tenant.marketplace_reviewer_purpose
    AND owner.email IS NOT NULL
    AND (cardinality(cell_ids) = 0 OR cell.cell_id = ANY (cell_ids))
$$;

-- The two new email kinds join the outbox's fixed set. The list repeats
-- migration 0089's, plus these two.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox ADD CONSTRAINT exomem_email_outbox_kind_check CHECK (
  kind IN ('start', 'place_opened', 'waitlist', 'hold_reminder', 'ready', 'payment_failed',
    'subscription_ended', 'deletion_reminder', 'deleted', 'invitation', 'friend_invitation', 'covered_invitation',
    'invitation_reminder', 'invitation_used', 'invitation_ended',
    'email_change_confirmation', 'email_change_cancellation',
    'invitation_waiting', 'waitlist_still_waiting', 'app_signout',
    'maintenance_scheduled', 'incident_resolved')
);
