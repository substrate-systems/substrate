-- Every accepted "Start with your email" request queues one email that states
-- its outcome. Two outcomes had none: an address with an open invitation
-- (`invitation_waiting`) and a person who already waits and asks again
-- (`waitlist_still_waiting`). Both kinds join the fixed capabilities of the
-- outbox; the list repeats migration 0077's, plus these two.
ALTER TABLE exomem_email_outbox DROP CONSTRAINT exomem_email_outbox_kind_check;
ALTER TABLE exomem_email_outbox ADD CONSTRAINT exomem_email_outbox_kind_check CHECK (
  kind IN ('start', 'place_opened', 'waitlist', 'hold_reminder', 'ready', 'payment_failed',
    'subscription_ended', 'deletion_reminder', 'deleted', 'invitation', 'friend_invitation', 'covered_invitation',
    'invitation_reminder', 'invitation_used', 'invitation_ended',
    'email_change_confirmation', 'email_change_cancellation',
    'invitation_waiting', 'waitlist_still_waiting')
);
