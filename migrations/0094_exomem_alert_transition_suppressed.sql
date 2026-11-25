-- Migration 0094 — Exomem alert transitions: tell an emailed row from a suppressed one.
--
-- The receiver marks a repeated state as delivered without sending an email
-- (isRedundantTransition). A still-active alert is news again 23 hours after
-- its last email, so the receiver must know when that last email went out. A
-- suppressed row is also `delivered`, which the notified_at check requires,
-- so this flag is the only way to tell the two apart. Rows that exist already
-- keep false and count as emailed.
SET LOCAL lock_timeout = '5s';

ALTER TABLE exomem_hosted_alert_transitions
  ADD COLUMN suppressed boolean NOT NULL DEFAULT false;

-- The redundancy lookup reads the latest emailed row for one (job, alert).
-- The key watcher adds a suppressed row every hour for the life of the table,
-- so the index holds emailed rows only and the lookup never walks past them.
DROP INDEX exomem_hosted_alert_transitions_latest_delivered_idx;
CREATE INDEX exomem_hosted_alert_transitions_latest_emailed_idx
  ON exomem_hosted_alert_transitions (job, alert, received_at DESC)
  WHERE notification_state = 'delivered' AND NOT suppressed;
