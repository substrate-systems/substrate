-- Migration 0087 — Exomem email delivery evidence.
--
-- An outbox row says only that the provider accepted a send. These columns and
-- this table let an operator see what became of the email afterwards (the
-- provider's own delivered, deferred and bounce events) and how long each step
-- took, without storing an address, a subject, a reason text or an IP.

-- The provider's id for the accepted send, without its angle brackets. The
-- provider's webhook names the same id, which is how an event finds its row.
ALTER TABLE exomem_email_outbox
  ADD COLUMN provider_message_id text
    CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 512),
  -- When the row was first due. Most kinds are due when queued; a reminder is
  -- due days later by design, so "queued to accepted" counts from here and a
  -- retry's later not_before never hides a slow send. NULL on older rows.
  ADD COLUMN due_at timestamptz;
ALTER TABLE exomem_email_outbox ALTER COLUMN due_at SET DEFAULT now();

ALTER TABLE exomem_access_delivery_outbox
  ADD COLUMN provider_message_id text
    CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 512);

-- The delivery report reads each outbox over a recent window of created_at.
CREATE INDEX exomem_email_outbox_created_idx ON exomem_email_outbox (created_at);
CREATE INDEX exomem_access_delivery_outbox_created_idx ON exomem_access_delivery_outbox (created_at);

-- The email health proof asks whether anything failed in the last hour. Failed
-- rows are rare, so these indexes stay small.
CREATE INDEX exomem_email_outbox_failed_idx
  ON exomem_email_outbox (updated_at) WHERE state = 'failed';
CREATE INDEX exomem_access_delivery_outbox_failed_idx
  ON exomem_access_delivery_outbox (updated_at) WHERE state = 'failed';

-- One row per provider event for a message. The event names are the provider's
-- documented transactional set (Brevo), a closed protocol rather than data; the
-- provider's opens and clicks are not stored. A redelivered event changes
-- nothing: the unique key makes the insert idempotent, and its index leads with
-- the message id the report joins on.
CREATE TABLE exomem_email_provider_events (
  provider_message_id text NOT NULL
    CHECK (char_length(provider_message_id) BETWEEN 1 AND 512),
  event text NOT NULL
    CHECK (event IN ('request', 'delivered', 'deferred', 'soft_bounce', 'hard_bounce',
      'blocked', 'spam', 'invalid_email', 'error', 'unsubscribed')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_message_id, event, occurred_at)
);

-- Retention: the access-delivery job deletes events 30 days after receipt.
CREATE INDEX exomem_email_provider_events_received_idx
  ON exomem_email_provider_events (received_at);
