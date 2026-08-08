-- Exomem Hosted self-serve admission.
--
-- Admission must be decided before money changes hands, so a visitor is either
-- admitted (an invite is minted for them automatically, with no operator in the
-- loop) or waitlisted. Both outcomes are recorded here.
--
-- `self_serve` distinguishes an automatically minted invite from an operator
-- issued one. Operator invites carry a real principal digest; self-serve invites
-- carry the fixed sentinel digest for the admission subsystem, so the existing
-- NOT NULL constraint holds without pretending a human authorised each one.

ALTER TABLE exomem_invites
  ADD COLUMN IF NOT EXISTS self_serve boolean NOT NULL DEFAULT false;

-- Outstanding self-serve invites are soft capacity reservations: admission has
-- been promised but the hard reservation only happens when the invite is
-- redeemed. The partial index keeps the headroom count cheap.
CREATE INDEX IF NOT EXISTS exomem_invites_outstanding_self_serve_idx
  ON exomem_invites (expires_at)
  WHERE self_serve AND consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS exomem_waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized citext NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Set when capacity frees up and this entry is converted into an invite, so a
  -- visitor is never admitted twice off one waitlist row.
  admitted_at timestamptz,
  admitted_invite_id uuid REFERENCES exomem_invites(id) ON DELETE SET NULL,
  notified_at timestamptz,
  CHECK (
    (admitted_at IS NULL AND admitted_invite_id IS NULL)
    OR
    (admitted_at IS NOT NULL AND admitted_invite_id IS NOT NULL)
  )
);

-- Position in the queue is by arrival among entries not yet admitted.
CREATE INDEX IF NOT EXISTS exomem_waitlist_entries_pending_idx
  ON exomem_waitlist_entries (created_at)
  WHERE admitted_at IS NULL;
