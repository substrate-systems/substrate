-- OpenSpec change send-monthly-whats-new-digest: the monthly digest's selection.
--
-- One row per month the daily route builds: the notes of the month's releases,
-- the model's ranking, the operator's blind pick and decision, and the final
-- ordered selection that the sending half queues. Nothing here sends email.
-- The states are a closed set that the code implements
-- (whats-new-digest/states.ts and months.ts).
SET LOCAL lock_timeout = '5s';

CREATE TABLE exomem_whats_new_digest_months (
  -- The month in UTC, 'YYYY-MM'. A release belongs to the month of its publish date.
  month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  state text NOT NULL CHECK (state IN (
    'waiting_for_notes',   -- a release of the month has no readable notes yet
    'waiting_for_model',   -- every release is read; the ranking is not yet in
    'awaiting_approval',   -- the ranking is in; the operator decides
    'ready_to_queue',      -- approved or edited; final_selection is the digest
    'queued',              -- the delivery job found no owner left to queue; it scans the month no more
    'skipped',             -- nothing is sent for the month
    'lapsed'               -- still waiting when the next month was built; never sent
  )),
  skip_reason text CHECK (skip_reason IN ('operator', 'quiet', 'too_few_notes')),
  -- True once the month's release list was read in full. It cannot grow
  -- afterwards: a release is published once, in the month of that moment.
  releases_listed_at timestamptz,
  last_checked_at timestamptz,
  -- Why the last ranking attempt left the month waiting. NULL once it ranked.
  model_status text CHECK (model_status IN ('not_configured', 'unavailable')),
  -- The model and the prompt that ranked the month. A change to either
  -- restarts the measurement's count (whats-new-digest/measurement.ts).
  -- NULL while no ranking ran, and for a month that had no ranking to run.
  model_id text,
  prompt_version text,
  -- Ranked note identifiers, [{"version": "1.2.3", "position": 0}, ...]. NULL
  -- until the ranking is in; [] is the model's "none". The note's own text
  -- is never stored here: the email reads it from the stored notes files.
  model_selection jsonb CHECK (model_selection IS NULL OR jsonb_typeof(model_selection) = 'array'),
  model_ranked_at timestamptz,
  -- The operator's own pick, taken before the page shows the model's. NULL
  -- until recorded; [] is "none". It never changes once recorded: it is the
  -- measurement's answer key.
  blind_pick jsonb CHECK (blind_pick IS NULL OR jsonb_typeof(blind_pick) = 'array'),
  blind_picked_at timestamptz,
  -- 'automatic' is the operator's switch to send without approval.
  decision text CHECK (decision IN ('approved', 'edited', 'automatic')),
  final_selection jsonb CHECK (final_selection IS NULL OR jsonb_typeof(final_selection) = 'array'),
  decided_at timestamptz,
  -- The delivery job's progress (whats-new-digest/fan-out.ts): it queues the
  -- owners in tenant id order, 200 a tick, and keeps the last tenant id it
  -- read, so each tick starts after it and a finished month is never scanned
  -- again. queued_count is the digests queued so far.
  queue_cursor uuid,
  queued_count integer NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK ((state IN ('ready_to_queue', 'queued')) = (decision IS NOT NULL)),
  CHECK ((state = 'queued') = (queued_at IS NOT NULL)),
  CHECK (state IN ('ready_to_queue', 'queued') OR (queue_cursor IS NULL AND queued_count = 0)),
  CHECK ((decision IS NULL) = (final_selection IS NULL)),
  -- The bar: an approved month has 3 to 6 notes.
  CHECK (final_selection IS NULL OR jsonb_array_length(final_selection) BETWEEN 3 AND 6),
  CHECK ((blind_pick IS NULL) = (blind_picked_at IS NULL)),
  CHECK ((model_selection IS NULL) = (model_ranked_at IS NULL))
);

-- One row per release of a month. The notes file is kept as fetched and is
-- never fetched again; a release without a readable file stays visible.
CREATE TABLE exomem_whats_new_digest_releases (
  month text NOT NULL REFERENCES exomem_whats_new_digest_months (month) ON DELETE CASCADE,
  -- The release tag without its v: three plain integers.
  version text NOT NULL CHECK (version ~ '^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}$'),
  published_at timestamptz NOT NULL,
  -- The release's notes asset on the GitHub API; NULL while the release lists none.
  asset_url text,
  -- The release's notes file, parsed and validated; NULL while it is missing.
  -- {"schema": 2, "releases": [] | [one entry]}
  notes_file jsonb,
  -- Why the notes are missing: the release lists no asset, its asset could not
  -- be fetched yet, or the file is not the notes format. Set exactly when
  -- notes_file is NULL.
  problem text CHECK (problem IN ('no_asset', 'unfetched', 'unreadable')),
  -- The operator accepted the month without this release.
  accepted_without_at timestamptz,
  PRIMARY KEY (month, version),
  CHECK ((notes_file IS NULL) = (problem IS NOT NULL))
);

-- The operator's recorded choice to send without approval (D2), and the
-- shares behind it. The newest row is the current choice; turning approval back
-- on is a row too. A row that sets the switch on names the model and the
-- prompt it was measured under, and the three months' shares.
CREATE TABLE exomem_whats_new_digest_switch (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  send_without_approval boolean NOT NULL,
  model_id text,
  prompt_version text,
  -- [{"month": "2026-12", "both": 2, "operatorPicks": 3}, x3]
  shares jsonb NOT NULL DEFAULT '[]',
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    NOT send_without_approval
    OR (model_id IS NOT NULL AND prompt_version IS NOT NULL AND jsonb_array_length(shares) = 3)
  )
);
