-- Durable landing table for K3s scheduler alert transitions.
--
-- The receiver commits one row before returning 2xx, so an accepted transition
-- survives a notification failure, a function timeout, or a redeploy. The
-- sender derives `transition_id` from a stable sequence+content digest, so the
-- primary key is the replay control: a redelivered transition conflicts and is
-- acknowledged without notifying twice.
--
-- No column may carry user content. `job` and `alert` are contract label names
-- and are bounded and character-restricted here as well as in the receiver.

CREATE TABLE exomem_hosted_alert_transitions (
  transition_id text PRIMARY KEY,
  job text NOT NULL,
  alert text NOT NULL,
  active boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  notification_state text NOT NULL DEFAULT 'pending',
  notification_attempts integer NOT NULL DEFAULT 0,
  notified_at timestamptz,
  last_error_code text,
  CONSTRAINT exomem_hosted_alert_transition_id_check
    CHECK (transition_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT exomem_hosted_alert_job_check
    CHECK (job ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT exomem_hosted_alert_name_check
    CHECK (alert ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  CONSTRAINT exomem_hosted_alert_notification_state_check
    CHECK (notification_state IN ('pending', 'delivered', 'failed')),
  CONSTRAINT exomem_hosted_alert_notification_attempts_check
    CHECK (notification_attempts >= 0),
  CONSTRAINT exomem_hosted_alert_notified_at_check
    CHECK ((notification_state = 'delivered') = (notified_at IS NOT NULL)),
  CONSTRAINT exomem_hosted_alert_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$')
);

-- Drives the bounded undelivered-backlog flush and the backlog health signal.
-- Partial: delivered rows are the overwhelming majority and never scanned.
CREATE INDEX exomem_hosted_alert_transitions_undelivered_idx
  ON exomem_hosted_alert_transitions (received_at)
  WHERE notification_state <> 'delivered';
