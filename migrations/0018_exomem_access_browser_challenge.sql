-- Upgrade safety for environments that applied the draft 0017 before magic
-- links became browser-bound. Old bearer links are revoked rather than
-- grandfathered into the stronger contract.

ALTER TABLE exomem_tenants
  ADD COLUMN IF NOT EXISTS magic_link_generation bigint NOT NULL DEFAULT 0;

ALTER TABLE exomem_access_tokens
  ADD COLUMN IF NOT EXISTS browser_challenge_digest bytea;

ALTER TABLE exomem_access_tokens
  ADD COLUMN IF NOT EXISTS magic_link_generation bigint;

UPDATE exomem_access_delivery_outbox AS outbox
SET state = 'failed',
    secret_ciphertext = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'LEGACY_MAGIC_LINK_REVOKED',
    updated_at = now()
FROM exomem_access_tokens AS token
WHERE outbox.token_id = token.id
  AND token.purpose = 'magic_link'
  AND token.browser_challenge_digest IS NULL
  AND outbox.state IN ('pending', 'leased');

UPDATE exomem_access_tokens
SET revoked_at = COALESCE(revoked_at, now()),
    delivery_state = 'failed',
    delivery_error_code = 'LEGACY_MAGIC_LINK_REVOKED'
WHERE purpose = 'magic_link'
  AND browser_challenge_digest IS NULL
  AND consumed_at IS NULL;

-- Retain consumed/revoked token audit rows while satisfying the new invariant.
-- Active legacy tokens were revoked above, so this value can never authenticate.
UPDATE exomem_access_tokens
SET browser_challenge_digest = token_digest
WHERE purpose = 'magic_link'
  AND browser_challenge_digest IS NULL;

-- A pre-generation draft could have admitted two concurrent browser-bound
-- links. Keep only its deterministic newest link authoritative. Historical
-- rows remain for audit, while pending delivery secrets are scrubbed.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, tenant_id
           ORDER BY created_at DESC, id DESC
         ) AS position
  FROM exomem_access_tokens
  WHERE purpose = 'magic_link'
    AND consumed_at IS NULL
    AND revoked_at IS NULL
)
UPDATE exomem_access_delivery_outbox AS outbox
SET state = 'failed',
    secret_ciphertext = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = 'SUPERSEDED_MAGIC_LINK',
    updated_at = now()
FROM ranked
WHERE outbox.token_id = ranked.id
  AND ranked.position > 1
  AND outbox.state IN ('pending', 'leased');

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, tenant_id
           ORDER BY created_at DESC, id DESC
         ) AS position
  FROM exomem_access_tokens
  WHERE purpose = 'magic_link'
    AND consumed_at IS NULL
    AND revoked_at IS NULL
)
UPDATE exomem_access_tokens AS token
SET revoked_at = now(),
    delivery_state = 'failed',
    delivery_error_code = 'SUPERSEDED_MAGIC_LINK'
FROM ranked
WHERE token.id = ranked.id
  AND ranked.position > 1;

UPDATE exomem_access_tokens
SET magic_link_generation = 0
WHERE purpose = 'magic_link'
  AND magic_link_generation IS NULL;

ALTER TABLE exomem_access_tokens
  ADD CONSTRAINT exomem_access_tokens_browser_challenge_check
  CHECK (
    (purpose = 'magic_link' AND browser_challenge_digest IS NOT NULL
      AND octet_length(browser_challenge_digest) = 32)
    OR (purpose = 'deletion_confirmation' AND browser_challenge_digest IS NULL)
  );

ALTER TABLE exomem_tenants
  ADD CONSTRAINT exomem_tenants_magic_link_generation_check
  CHECK (magic_link_generation >= 0);

ALTER TABLE exomem_access_tokens
  ADD CONSTRAINT exomem_access_tokens_magic_link_generation_check
  CHECK (
    (purpose = 'magic_link' AND magic_link_generation IS NOT NULL
      AND magic_link_generation >= 0)
    OR (purpose = 'deletion_confirmation' AND magic_link_generation IS NULL)
  );
