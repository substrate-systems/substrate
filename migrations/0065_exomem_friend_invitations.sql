-- Migration 0065 — Exomem friend invitations and resubscribe.
--
-- An operator invitation has a kind: `standard` (paid), `friend` (paid, with
-- the friend price) or `covered` (complimentary). A friend invitation names
-- its inviter and may carry a note and the inviter's email, which receives
-- the "used" and "ended unused" notices. An owner who already has Exomem
-- records a decision on the invitation instead of redeeming it. A tenant that
-- accepted a friend invitation keeps a pointer to it, so checkout and
-- resubscribe attach the friend discount on the server.

ALTER TABLE exomem_invites
  ADD COLUMN kind text,
  ADD COLUMN inviter_name text,
  ADD COLUMN inviter_email citext,
  ADD COLUMN invitee_name text,
  ADD COLUMN note text,
  ADD COLUMN decision text,
  ADD COLUMN decided_at timestamptz;

UPDATE exomem_invites
SET kind = CASE WHEN entitlement_source = 'complimentary' THEN 'covered' ELSE 'standard' END;

-- An insert that names no kind takes the kind of its entitlement source, so
-- the paths that predate kinds (self-serve start links, waitlist promotion)
-- stay correct. The CHECK below still refuses an inconsistent pair.
CREATE FUNCTION exomem_invites_default_kind() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.kind IS NULL THEN
    NEW.kind := CASE WHEN NEW.entitlement_source = 'complimentary' THEN 'covered' ELSE 'standard' END;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER exomem_invites_default_kind
BEFORE INSERT ON exomem_invites
FOR EACH ROW EXECUTE FUNCTION exomem_invites_default_kind();

ALTER TABLE exomem_invites
  ALTER COLUMN kind SET NOT NULL,
  ADD CONSTRAINT exomem_invites_kind_check
    CHECK (kind IN ('standard', 'friend', 'covered')),
  ADD CONSTRAINT exomem_invites_kind_source_check
    CHECK ((kind = 'covered') = (entitlement_source = 'complimentary')),
  ADD CONSTRAINT exomem_invites_inviter_name_length
    CHECK (inviter_name IS NULL OR char_length(inviter_name) BETWEEN 1 AND 60),
  ADD CONSTRAINT exomem_invites_invitee_name_length
    CHECK (invitee_name IS NULL OR char_length(invitee_name) BETWEEN 1 AND 60),
  ADD CONSTRAINT exomem_invites_note_length
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 280),
  -- Only a friend invitation tells its inviter anything (emails 12 and 13).
  ADD CONSTRAINT exomem_invites_inviter_email_friend_only
    CHECK (inviter_email IS NULL OR (kind = 'friend' AND char_length(inviter_email) BETWEEN 3 AND 254)),
  -- The decision is the answer the decision route returned, so a repeat
  -- returns the same answer.
  ADD CONSTRAINT exomem_invites_decision_check
    CHECK (decision IS NULL OR decision IN ('applied', 'applied_on_resubscribe', 'kept')),
  ADD CONSTRAINT exomem_invites_decision_pair
    CHECK ((decision IS NULL) = (decided_at IS NULL)),
  ADD CONSTRAINT exomem_invites_decision_consumed
    CHECK (decision IS NULL OR consumed_at IS NOT NULL);

-- Account deletion clears the inviter's address from the invitations they asked for.
CREATE INDEX exomem_invites_inviter_email_idx
  ON exomem_invites (inviter_email)
  WHERE inviter_email IS NOT NULL;

-- The friend invitation the tenant accepted, through redemption or a decision.
-- Deleting the invitation (account deletion) removes the offer with it.
ALTER TABLE exomem_tenants
  ADD COLUMN friend_offer_invite_id uuid REFERENCES exomem_invites(id) ON DELETE SET NULL;

-- Deleting an invitation sets this column to NULL; without the index, each
-- deleted invitation scans every tenant.
CREATE INDEX exomem_tenants_friend_offer_invite_idx
  ON exomem_tenants (friend_offer_invite_id)
  WHERE friend_offer_invite_id IS NOT NULL;

-- Each kind has one renderer in code (email-outbox.ts). This replaces the
-- named constraint from migration 0063 with the invitation kinds added.
ALTER TABLE exomem_email_outbox
  DROP CONSTRAINT exomem_email_outbox_kind_check,
  ADD CONSTRAINT exomem_email_outbox_kind_check
    CHECK (kind IN (
      'start', 'place_opened', 'waitlist', 'hold_reminder',
      'invitation', 'friend_invitation', 'covered_invitation',
      'invitation_reminder', 'invitation_used', 'invitation_ended'
    ));
