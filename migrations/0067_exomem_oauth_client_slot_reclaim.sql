-- OAuth client slot reclaim (reclaim-oauth-client-slots).
--
-- Every partition of the client population bound counted every row it ever
-- admitted, so each one could only fill. Retirement gives a slot back without
-- deleting the row: which clients existed, and which carried reviewer
-- bootstrap history, stays checkable, and grants, tokens and evidence keep
-- the client they reference.

-- The runner applies this file in one transaction, and each table lock lasts
-- until it commits. A statement that waits for a lock blocks every request
-- queued behind it, so the migration fails after five seconds instead.
SET LOCAL lock_timeout = '5s';

ALTER TABLE exomem_oauth_clients
  ADD COLUMN retired_at timestamptz;

-- A retired client takes no slot, so it must never be usable: enabling one
-- would admit a client the bound does not count. The first-party Home client
-- takes no slot and is never retired.
ALTER TABLE exomem_oauth_clients
  ADD CONSTRAINT exomem_oauth_clients_retired_disabled
  CHECK (retired_at IS NULL OR (NOT enabled AND admission_mode <> 'first_party'));

-- Every registration reads the partition count, and every sweep reads its
-- retirement candidates. Unretired rows stay at most the sum of the bounds
-- while retired rows accumulate, so both read this index instead of the table.
CREATE INDEX exomem_oauth_clients_unretired_partition_idx
  ON exomem_oauth_clients (admission_mode, auto_registered)
  WHERE retired_at IS NULL AND admission_mode <> 'first_party';

-- Every clients statement comes before the index builds. A token request
-- reads clients and then writes tokens, so taking the token tables first
-- would deadlock with a request in flight.

-- The retirement sweep looks up each candidate client's grants.
CREATE INDEX exomem_oauth_grants_client_idx
  ON exomem_oauth_grants (client_id);

-- The sweep now runs, and each row it deletes makes a foreign-key action look
-- up the rows that reference it: grants by authorization transaction, child
-- refresh tokens by parent, and refresh and access tokens by family. Without
-- these indexes each lookup reads the whole referencing table, 500 times a
-- run, so a run's time grows with every token ever issued.
CREATE INDEX exomem_oauth_grants_authorization_transaction_idx
  ON exomem_oauth_grants (authorization_transaction_id)
  WHERE authorization_transaction_id IS NOT NULL;
CREATE INDEX exomem_oauth_refresh_tokens_parent_idx
  ON exomem_oauth_refresh_tokens (parent_refresh_token_id)
  WHERE parent_refresh_token_id IS NOT NULL;
CREATE INDEX exomem_oauth_refresh_tokens_family_idx
  ON exomem_oauth_refresh_tokens (family_id);
CREATE INDEX exomem_oauth_access_tokens_family_idx
  ON exomem_oauth_access_tokens (family_id);

-- Each partition's bound is data, so an operator changes it with one UPDATE
-- and no migration. The three partition names are this schema's own closed
-- set. A missing row closes its partition: the gates refuse every new client
-- in it rather than admit one without a bound. The operator headroom request
-- then fails with a generic internal error that does not name the partition.
CREATE TABLE exomem_oauth_client_partition_bounds (
  client_partition text PRIMARY KEY
    CHECK (client_partition IN ('operator', 'auto_registered', 'generic')),
  bound integer NOT NULL CHECK (bound >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Launch defaults. Each bound limits the rows that one partition can add per
-- retirement grace. Too low, and people cannot connect; too high, and a
-- registration flood grows the table by up to the bound per grace.
INSERT INTO exomem_oauth_client_partition_bounds (client_partition, bound) VALUES
  -- Registered by hand. Migration 0051's value, about three times its use.
  ('operator', 96),
  -- One client per ChatGPT connector, so this caps connected ChatGPT users.
  -- Fifty for each of 1,000 accounts: a heavy user runs 15 to 25 apps or more.
  ('auto_registered', 50000),
  -- One client per installed app, and more where an app registers again.
  -- Fifty for each of 1,000 accounts, for the same heavy users.
  ('generic', 50000)
ON CONFLICT (client_partition) DO NOTHING;

-- The partitions, their bounds and their use, defined once. The admission
-- gates and the operator headroom report both read this function, so the
-- reported bound is the enforced bound.
CREATE FUNCTION exomem_oauth_client_partitions()
RETURNS TABLE (client_partition text, bound integer, used integer)
LANGUAGE sql STABLE AS $$
  SELECT bounds.client_partition, bounds.bound,
         (
           SELECT count(*)::integer
           FROM exomem_oauth_clients AS client
           WHERE client.retired_at IS NULL
             AND client.admission_mode <> 'first_party'
             AND CASE
                   WHEN client.admission_mode = 'generic' THEN 'generic'
                   WHEN client.auto_registered THEN 'auto_registered'
                   ELSE 'operator'
                 END = bounds.client_partition
         )
  FROM exomem_oauth_client_partition_bounds AS bounds
$$;

COMMENT ON FUNCTION exomem_oauth_client_partitions() IS
  'Client population partitions (operator, auto_registered CIMD, generic), '
  'each with its bound from exomem_oauth_client_partition_bounds and its count '
  'of unretired clients. First-party clients take no slot. The single '
  'definition of every partition, bound and count.';

-- An existing client keeps its own slot only while it holds one. A retired
-- client that returns needs a free slot like a new one: otherwise reviving
-- retired rows could push a partition past its bound.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partition_available(
  p_client_id text,
  p_auto_registered boolean
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM exomem_oauth_clients
      WHERE client_id = p_client_id AND retired_at IS NULL
    )
    OR COALESCE((
      SELECT slots.used < slots.bound
      FROM exomem_oauth_client_partitions() AS slots
      WHERE slots.client_partition =
        CASE WHEN p_auto_registered THEN 'auto_registered' ELSE 'operator' END
    ), false);
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Whether an operator or auto-registered CIMD client may take or keep a slot: '
  'it already holds one, or its partition in exomem_oauth_client_partitions has '
  'one free. A retired client holds none.';

CREATE OR REPLACE FUNCTION exomem_oauth_generic_client_partition_available()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT slots.used < slots.bound
    FROM exomem_oauth_client_partitions() AS slots
    WHERE slots.client_partition = 'generic'
  ), false);
$$;

COMMENT ON FUNCTION exomem_oauth_generic_client_partition_available() IS
  'Whether the generic partition in exomem_oauth_client_partitions has a free '
  'slot for a new dynamically registered client.';

-- Every client to which something issued can still be used, or is being
-- issued now: a grant that is not revoked, an unexpired code, access token or
-- refresh token, or an authorization in progress. Retirement is refused for
-- each client listed, whatever its age. A grant that is not revoked counts even
-- without tokens: Home lists it as a connected app. The sweep anti-joins this
-- view, so it reads each table once rather than once per candidate client.
CREATE VIEW exomem_oauth_clients_holding_live_authority AS
  SELECT client_id FROM exomem_oauth_grants
  WHERE revoked_at IS NULL
  UNION ALL
  SELECT client_id FROM exomem_oauth_authorization_codes
  WHERE consumed_at IS NULL AND expires_at > now()
  UNION ALL
  SELECT client_id FROM exomem_oauth_access_tokens
  WHERE revoked_at IS NULL AND expires_at > now()
  UNION ALL
  SELECT family.client_id
  FROM exomem_oauth_token_families AS family
  WHERE family.revoked_at IS NULL AND family.expires_at > now()
    AND EXISTS (
      SELECT 1 FROM exomem_oauth_refresh_tokens AS token
      WHERE token.family_id = family.id
        AND token.consumed_at IS NULL AND token.expires_at > now()
    )
  UNION ALL
  -- Invite admission (admitFirstCloudOAuthInviteAtomic) reads a transaction as
  -- live at its own start time and takes no cohort lock, so this arm keeps one
  -- minute of margin past expiry.
  SELECT client_id FROM exomem_oauth_authorization_transactions
  WHERE consumed_at IS NULL AND expires_at > now() - interval '1 minute';

COMMENT ON VIEW exomem_oauth_clients_holding_live_authority IS
  'Clients that hold a grant that is not revoked, an unexpired code, access '
  'token or refresh token, or an authorization in progress. Every retirement '
  'path refuses them. A client may appear more than once.';

-- The same rule for one client, for an operator statement.
CREATE FUNCTION exomem_oauth_client_holds_live_authority(p_client uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM exomem_oauth_clients_holding_live_authority
    WHERE client_id = p_client
  );
$$;

COMMENT ON FUNCTION exomem_oauth_client_holds_live_authority(uuid) IS
  'Whether one client appears in exomem_oauth_clients_holding_live_authority.';
