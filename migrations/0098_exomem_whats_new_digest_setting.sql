-- OpenSpec change send-monthly-whats-new-digest: the sending half.
--
-- The owner's "Monthly update email" setting, the invitation that Home shows
-- to an owner who existed before it, the outbox kind of the digest and its
-- send tier, and the one definition of who may receive a digest now.
SET LOCAL lock_timeout = '5s';

-- whats_new_digest is the setting. The unsubscribe link, Home's toggle and the
-- operator's action change this one value. It is off unless the row says
-- otherwise: only a client that showed the owner the switch (signup) may write
-- it on, so a row written any other way is off.
--
-- whats_new_digest_invitation is Home's invitation, a closed set that the code
-- implements (whats-new-digest/setting.ts):
--   none       the owner signed up after the digest shipped and is never invited
--   open       an owner who existed before it, never invited so far: Home asks once
--   dismissed  the owner dismissed the invitation
--   accepted   the owner, or the operator for them, turned the setting on at
--              least once. It stays, so an owner who later unsubscribes is not asked again.
--
-- whats_new_digest_off_since is when the owner turned the setting off, while it
-- stays off: set when the setting goes from on to off (Home's toggle or the
-- unsubscribe link), cleared when it goes on. The operator's action reports it,
-- so an owner who unsubscribed and asks again is not turned on unknowingly.
--
-- whats_new_digest_operator_on_at and _by record the operator's own action that
-- turned the setting on for an owner who asked: when, and the operator
-- principal's digest. They live on the row, so deleting the account deletes them.
ALTER TABLE exomem_tenants
  ADD COLUMN whats_new_digest boolean NOT NULL DEFAULT false,
  ADD COLUMN whats_new_digest_invitation text NOT NULL DEFAULT 'none'
    CONSTRAINT exomem_tenants_whats_new_digest_invitation_check
    CHECK (whats_new_digest_invitation IN ('none', 'open', 'dismissed', 'accepted')),
  ADD COLUMN whats_new_digest_off_since timestamptz
    CONSTRAINT exomem_tenants_whats_new_digest_off_since_check
    CHECK (NOT whats_new_digest OR whats_new_digest_off_since IS NULL),
  ADD COLUMN whats_new_digest_operator_on_at timestamptz,
  ADD COLUMN whats_new_digest_operator_on_by bytea
    CONSTRAINT exomem_tenants_whats_new_digest_operator_on_by_check
    CHECK (whats_new_digest_operator_on_by IS NULL OR octet_length(whats_new_digest_operator_on_by) = 32),
  ADD CONSTRAINT exomem_tenants_whats_new_digest_operator_on_check
    CHECK ((whats_new_digest_operator_on_at IS NULL) = (whats_new_digest_operator_on_by IS NULL));

-- Every owner who exists now was never offered this email, so the setting is
-- off for them (the column's default above) and Home invites each of them.
-- A new owner starts with the invitation 'none' (the column's default).
UPDATE exomem_tenants SET whats_new_digest_invitation = 'open';

-- The delivery job pages through the owners who have the setting on, in
-- tenant id order, 200 a tick.
CREATE INDEX exomem_tenants_whats_new_digest_idx
  ON exomem_tenants (id)
  WHERE whats_new_digest;

-- The owners a digest may reach right now: the setting is on, the account is
-- live and is not a marketplace reviewer's fixture, the owner has an address,
-- and the cell runs and is ready (not stopped, paused for a hold, failed or
-- deleted). `running_release` is the release tag of the image the cell runs,
-- NULL when none is recorded. The delivery job's queue pass and the send-time
-- check both read this one definition. STABLE and one SELECT, so PostgreSQL
-- inlines it and pushes a `tenant_id` filter into the scan.
CREATE FUNCTION exomem_whats_new_digest_recipients()
RETURNS TABLE (
  tenant_id uuid, owner_email text, time_zone text, email_scheme text, theme_choice text,
  running_release text
)
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT tenant.id, owner.email::text, tenant.time_zone, tenant.email_scheme, tenant.theme_choice,
         (SELECT history.release_tag FROM exomem_cloud_image_history AS history
           WHERE history.image = cell.observed_image)
  FROM exomem_tenants AS tenant
  JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
  JOIN exomem_cloud_cells AS cell ON cell.tenant_id = tenant.id
  WHERE tenant.whats_new_digest
    AND tenant.status NOT IN ('deletion_pending', 'deleted')
    AND NOT tenant.marketplace_reviewer_purpose
    AND owner.email IS NOT NULL
    AND cell.desired_state = 'running'
    AND cell.observed_state = 'running'
    AND cell.ready
    AND cell.last_error_code IS NULL
$$;

-- The digest joins the outbox's fixed set. The list repeats migration 0090's,
-- plus this kind.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox ADD CONSTRAINT exomem_email_outbox_kind_check CHECK (
  kind IN ('start', 'place_opened', 'waitlist', 'hold_reminder', 'ready', 'payment_failed',
    'subscription_ended', 'deletion_reminder', 'deleted', 'invitation', 'friend_invitation', 'covered_invitation',
    'invitation_reminder', 'invitation_used', 'invitation_ended',
    'email_change_confirmation', 'email_change_cancellation',
    'invitation_waiting', 'waitlist_still_waiting', 'app_signout',
    'maintenance_scheduled', 'incident_resolved', 'whats_new_digest')
);

-- The claim takes the lowest tier first, then the order the outbox always
-- had. Tier 0 is every kind that has no tier of its own, tier 1 the kinds
-- claimed last (the health canary's among them), tier 2 the monthly digest.
-- The application sets the tier at insert from the kind's definition
-- (email-outbox.ts); this backfill names the kinds that hold a tier now.
ALTER TABLE exomem_email_outbox
  ADD COLUMN send_tier smallint NOT NULL DEFAULT 0
    CONSTRAINT exomem_email_outbox_send_tier_check CHECK (send_tier BETWEEN 0 AND 2);

UPDATE exomem_email_outbox SET send_tier = 1
WHERE state IN ('pending', 'leased')
  AND kind IN ('waitlist', 'waitlist_still_waiting', 'invitation_waiting',
               'maintenance_scheduled', 'incident_resolved');

-- The claim's ORDER BY reads this index in order and stops at the first ready
-- row, so a queue holding 10,000 digests costs the same as an empty one.
CREATE INDEX exomem_email_outbox_claim_idx
  ON exomem_email_outbox (send_tier, not_before, created_at)
  WHERE state IN ('pending', 'leased');
