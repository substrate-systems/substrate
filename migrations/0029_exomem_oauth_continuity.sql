-- Browser OAuth continuity remains opaque: caller state is sealed server-side.
ALTER TABLE exomem_oauth_authorization_transactions
  ADD COLUMN state_envelope jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(state_envelope) = 'object');

ALTER TABLE exomem_oauth_authorization_transactions
  ADD COLUMN form_nonce_digest bytea NOT NULL DEFAULT decode(repeat('00', 32), 'hex')
    CHECK (octet_length(form_nonce_digest) = 32),
  ADD COLUMN continuation_binding bytea NOT NULL DEFAULT decode(repeat('00', 32), 'hex')
    CHECK (octet_length(continuation_binding) = 32);

ALTER TABLE exomem_oauth_authorization_transactions
  ALTER COLUMN state_envelope DROP DEFAULT,
  ALTER COLUMN form_nonce_digest DROP DEFAULT,
  ALTER COLUMN continuation_binding DROP DEFAULT;
