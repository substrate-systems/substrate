-- OpenSpec change send-monthly-whats-new-digest: corrections to the digest's
-- records and to the outbox's claim order.
--
-- 1. A month records the model that the API reported, next to the configured
--    name, and when its digests may start to queue (the operator's stop window).
-- 2. The operator can stop a month that is ready to queue or queued: it moves
--    to 'skipped' and keeps its approval, so three CHECKs of migration 0097 allow that.
-- 3. A new owner starts with the setting off unless signup says otherwise.
-- 4. The outbox row carries its send tier, so the claim's ORDER BY can use an index.
SET LOCAL lock_timeout = '5s';

-- 1. The identity of a ranking is the model the API reported and the prompt's
-- hash. model_id stays the name that configuration asked for.
ALTER TABLE exomem_whats_new_digest_months
  ADD COLUMN model_reported text,
  ADD COLUMN send_after timestamptz,
  ADD CONSTRAINT exomem_whats_new_digest_months_model_reported_check
    CHECK (model_reported IS NULL OR model_selection IS NOT NULL);

-- send_after is set with the decision: now for an approval, a day later for a
-- month that goes out on the operator's switch.
UPDATE exomem_whats_new_digest_months SET send_after = decided_at WHERE decision IS NOT NULL;

-- 2. A stopped month keeps what was decided and queued; only its state changes.
ALTER TABLE exomem_whats_new_digest_months
  DROP CONSTRAINT exomem_whats_new_digest_months_check1,
  DROP CONSTRAINT exomem_whats_new_digest_months_check2,
  DROP CONSTRAINT exomem_whats_new_digest_months_check3;

ALTER TABLE exomem_whats_new_digest_months
  ADD CONSTRAINT exomem_whats_new_digest_months_decision_state_check CHECK (
    CASE WHEN state IN ('ready_to_queue', 'queued') THEN decision IS NOT NULL
         WHEN state = 'skipped' THEN true -- stopped after its approval, or never decided
         ELSE decision IS NULL END),
  ADD CONSTRAINT exomem_whats_new_digest_months_queued_at_check CHECK (
    CASE WHEN state = 'queued' THEN queued_at IS NOT NULL
         WHEN state = 'skipped' THEN true
         ELSE queued_at IS NULL END),
  ADD CONSTRAINT exomem_whats_new_digest_months_queue_progress_check CHECK (
    state IN ('ready_to_queue', 'queued', 'skipped') OR (queue_cursor IS NULL AND queued_count = 0)),
  ADD CONSTRAINT exomem_whats_new_digest_months_send_after_check CHECK (
    (decision IS NULL) = (send_after IS NULL));

-- The switch row names the reported model too: the recorded choice holds only
-- while the API still reports the model that was measured.
ALTER TABLE exomem_whats_new_digest_switch
  ADD COLUMN model_reported text,
  DROP CONSTRAINT exomem_whats_new_digest_switch_check,
  ADD CONSTRAINT exomem_whats_new_digest_switch_check CHECK (
    NOT send_without_approval
    OR (model_id IS NOT NULL AND model_reported IS NOT NULL AND prompt_version IS NOT NULL
        AND jsonb_array_length(shares) = 3));

-- 3. Only a client that showed the owner the switch may opt the owner in
-- (signup passes the choice explicitly), so a row written any other way is off.
ALTER TABLE exomem_tenants ALTER COLUMN whats_new_digest SET DEFAULT false;

-- 4. The claim takes the lowest tier first, then the order the outbox always
-- had. Tier 0 is every kind that has no tier of its own, tier 1 the kinds
-- claimed last (the health canary's among them), tier 2 the monthly digest.
-- The application sets the tier at insert from the kind's definition
-- (email-outbox.ts); this backfill names the kinds that hold a tier now.
ALTER TABLE exomem_email_outbox
  ADD COLUMN send_tier smallint NOT NULL DEFAULT 0 CHECK (send_tier BETWEEN 0 AND 2);

UPDATE exomem_email_outbox SET send_tier = 1
WHERE state IN ('pending', 'leased')
  AND kind IN ('waitlist', 'waitlist_still_waiting', 'invitation_waiting',
               'maintenance_scheduled', 'incident_resolved');
UPDATE exomem_email_outbox SET send_tier = 2
WHERE state IN ('pending', 'leased') AND kind = 'whats_new_digest';

-- The claim's ORDER BY reads this index in order and stops at the first ready
-- row, so a queue holding 10,000 digests costs the same as an empty one.
CREATE INDEX exomem_email_outbox_claim_idx
  ON exomem_email_outbox (send_tier, not_before, created_at)
  WHERE state IN ('pending', 'leased');
