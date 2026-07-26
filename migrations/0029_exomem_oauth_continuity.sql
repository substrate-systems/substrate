-- Browser OAuth continuity remains opaque: caller state is sealed server-side.
ALTER TABLE exomem_oauth_authorization_transactions
  ADD COLUMN state_envelope jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(state_envelope) = 'object');

ALTER TABLE exomem_oauth_authorization_transactions
  ALTER COLUMN state_envelope DROP DEFAULT;
