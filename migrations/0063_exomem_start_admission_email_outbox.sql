-- Migration 0063 — Exomem start admission, email outbox and recipient time zones.
--
-- "Start with your email" gives every visitor the same page response and lets
-- the email carry the outcome. Every Exomem email that announces a fact (a
-- start link, a waitlist place, a place that opened, the unpaid-hold reminder)
-- is written to this outbox in the same transaction as that fact. The unique
-- dedupe_key is what makes an email "sent once". Delivery is at least once
-- under a lease, like the magic-link outbox (0017).
--
-- Magic links (email 01) stay on the 0017 outbox: the token's delivery state
-- gates its redemption, so they keep that coupling.

CREATE TABLE exomem_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The email catalogue of the Exomem design. Each kind has one renderer in
  -- code, so the set is fixed by code, not by data. The whole catalogue is
  -- listed now, so a change that adds a renderer needs no constraint change.
  kind text NOT NULL CHECK (kind IN (
    'sign_in',
    'start',
    'invite',
    'cell_ready',
    'payment_failed',
    'subscription_ended',
    'deletion_warning',
    'deleted',
    'export_ready',
    'friend_invite',
    'covered_invite',
    'invite_reminder',
    'invite_used',
    'invite_ended',
    'storage_nearly_full',
    'storage_full',
    'email_change_confirm',
    'email_change_notice',
    'vault_imported',
    'hold_reminder',
    'storage_added',
    'waitlist',
    'place_opened'
  )),
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  recipient citext NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 254),
  recipient_time_zone text
    CHECK (recipient_time_zone IS NULL OR char_length(recipient_time_zone) BETWEEN 1 AND 64),
  -- An encrypted envelope (security.ts). It can hold a bearer token, so it is
  -- kept only while the email can still be sent.
  payload_ciphertext jsonb,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The earliest send time. A retry moves it forward.
  not_before timestamptz NOT NULL DEFAULT now(),
  -- NULL means the email has no deadline of its own.
  expires_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (
    (state = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((state IN ('pending', 'leased')) = (payload_ciphertext IS NOT NULL)),
  CHECK (state <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX exomem_email_outbox_ready_idx
  ON exomem_email_outbox (not_before, created_at)
  WHERE state IN ('pending', 'leased');

-- IANA zone names, checked in code against the runtime's zone list. NULL
-- means unknown, and emails then label their times as UTC.
ALTER TABLE exomem_tenants
  ADD COLUMN time_zone text
    CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64);

ALTER TABLE exomem_waitlist_entries
  ADD COLUMN time_zone text
    CHECK (time_zone IS NULL OR char_length(time_zone) BETWEEN 1 AND 64);

ALTER TABLE exomem_invites
  ADD COLUMN recipient_time_zone text
    CHECK (recipient_time_zone IS NULL OR char_length(recipient_time_zone) BETWEEN 1 AND 64);

