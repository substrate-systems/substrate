-- Migration 0040 — two-phase backup version commit (harden-cloud-generation-durability)
-- Contract: §7 (commit endpoint), §8 (versioning model).
--
-- Before this migration a `backup_versions` row became durable, listable and
-- restorable the instant `POST /api/backups/:id/versions` minted its presigned
-- URLs — before a single byte reached R2. A push that died mid-upload left a
-- phantom version that listed as a restore target, counted against quota, and
-- (because retention was enforced at create time) had already evicted a
-- genuinely good older version.
--
-- committed_at: set by `POST /api/backups/:id/versions/:vid/commit` once the
-- client has uploaded every chunk and the manifest. NULL means "the bytes are
-- not known to be there".
--
-- Every new version is pending until publication. New clients publish with an
-- explicit commit; a bounded server reconciliation path serves clients that
-- predate that endpoint. Historical rows are retained but marked
-- `legacy_unverified` until their R2 object sets have been checked.

ALTER TABLE backup_versions ADD COLUMN committed_at timestamptz;

ALTER TABLE backup_versions
  ADD COLUMN requires_commit boolean NOT NULL DEFAULT false;

ALTER TABLE backup_versions
  ADD COLUMN legacy_unverified boolean NOT NULL DEFAULT false;

ALTER TABLE backup_versions
  ADD COLUMN legacy_verification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN legacy_verification_last_error text,
  ADD COLUMN legacy_quarantined boolean NOT NULL DEFAULT false;

ALTER TABLE backup_versions
  ADD COLUMN client_commit_required boolean NOT NULL DEFAULT false;

ALTER TABLE backup_versions
  ADD COLUMN client_operation_id text;

ALTER TABLE backup_versions
  ADD COLUMN gc_reclaim_token uuid,
  ADD COLUMN gc_reclaim_started_at timestamptz;

-- Release-A bridge: historical rows remain available while reconciliation is
-- drained, but no row minted after this migration can borrow that visibility.
CREATE TABLE hosted_backup_generation_visibility_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  strict_generation_visibility boolean NOT NULL DEFAULT false,
  legacy_cutoff timestamptz NOT NULL DEFAULT now()
);

INSERT INTO hosted_backup_generation_visibility_policy (singleton) VALUES (true);

-- A production Vercel build applies migrations before its new application
-- instance is live. Reject a pre-0040 writer during that narrow interval: it
-- cannot supply the server operation identity or enforce pending visibility.
-- Release-A routes always generate one, including for old engines.
CREATE FUNCTION reject_unbridged_generation_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.client_operation_id IS NULL
     AND NEW.created_at >= (SELECT legacy_cutoff FROM hosted_backup_generation_visibility_policy WHERE singleton = true) THEN
    RAISE EXCEPTION 'Release-A generation writes require a server operation identity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER backup_versions_release_a_insert_guard
  BEFORE INSERT ON backup_versions
  FOR EACH ROW EXECUTE FUNCTION reject_unbridged_generation_insert();

CREATE UNIQUE INDEX backup_versions_operation_id_unique
  ON backup_versions (backup_id, client_operation_id)
  WHERE client_operation_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE subscriptions
  ADD COLUMN provider_event_occurred_at timestamptz,
  ADD COLUMN provider_event_id text;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_provider_event_identity_unique
  UNIQUE (paddle_subscription_id, provider_event_id);

CREATE TABLE supporter_contributions (
  paddle_transaction_id text PRIMARY KEY,
  paddle_event_id text NOT NULL UNIQUE,
  tier text NOT NULL,
  customer_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE supporter_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paddle_transaction_id text NOT NULL REFERENCES supporter_contributions(paddle_transaction_id),
  kind text NOT NULL CHECK (kind IN ('founder_notification', 'supporter_thank_you')),
  attempts integer NOT NULL DEFAULT 0,
  processing_started_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (paddle_transaction_id, kind)
);

CREATE TABLE paddle_cancellation_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id_hash bytea NOT NULL,
  paddle_subscription_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  processing_started_at timestamptz,
  cancelled_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (paddle_subscription_id)
);

ALTER TABLE backup_versions
  ADD COLUMN manifest_size_bytes bigint;

UPDATE backup_versions v
SET manifest_size_bytes = v.size_bytes - COALESCE((
  SELECT SUM(c.size_bytes) FROM backup_chunks c WHERE c.version_id = v.id
), 0);

ALTER TABLE backup_versions
  ALTER COLUMN manifest_size_bytes SET NOT NULL;

-- Historical metadata only proves a row existed; it does not prove every R2
-- object still exists. Keep the rows and accounts intact. Release A keeps
-- only pre-cutoff history bridge-visible while strict visibility is false;
-- the bounded reconciliation pass must HEAD every expected object before the
-- guarded cutover can hide or publish that history permanently.
UPDATE backup_versions
SET requires_commit = false,
    legacy_unverified = true,
    client_commit_required = false,
    committed_at = NULL;

-- Drives the backup-gc pass that reclaims never-committed versions (and their
-- R2 objects) a few hours after mint. Partial index: the qualifying set is
-- tiny and short-lived, so the index stays near-empty in steady state.
CREATE INDEX backup_versions_uncommitted_idx
  ON backup_versions (created_at)
  WHERE committed_at IS NULL AND deleted_at IS NULL;

-- Drives the version-visibility predicate used by list/quota/summary reads.
CREATE INDEX backup_versions_visible_idx
  ON backup_versions (backup_id, created_at DESC)
  WHERE deleted_at IS NULL AND committed_at IS NOT NULL AND legacy_unverified = false;

CREATE INDEX backup_versions_legacy_bridge_idx
  ON backup_versions (created_at DESC)
  WHERE deleted_at IS NULL AND legacy_unverified = true;
