-- OpenSpec change count-oauth-client-partitions-incrementally.
--
-- Every registration checked its partition by counting the partition's
-- unretired clients, so the check grew with the population: about 55 ms at
-- 500,000 clients, and a bound sized for the load target could not be set.
-- Each partition's row in exomem_oauth_client_partition_bounds now carries its
-- use. Triggers keep it, the check reads one row, and an hourly recount from
-- the OAuth sweep corrects any drift.
SET LOCAL lock_timeout = '5s';

-- The partition of a client, defined once. NULL for the first-party Home
-- client, which takes no slot. An auto-registered row with no platform is a
-- CIMD client that only the generic lane admits, so it draws on that lane's
-- bound (0088).
CREATE FUNCTION exomem_oauth_client_partition_of(
  p_admission_mode text,
  p_auto_registered boolean,
  p_client_platform text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_admission_mode = 'first_party' THEN NULL
    WHEN p_admission_mode = 'generic' THEN 'generic'
    WHEN p_auto_registered AND p_client_platform IS NULL THEN 'generic'
    WHEN p_auto_registered THEN 'auto_registered'
    ELSE 'operator'
  END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_of(text, boolean, text) IS
  'The client population partition a client row counts in (operator, '
  'auto_registered or generic), or NULL for a first-party client.';

-- Applies per-partition changes to the counters. Rows lock in partition-name
-- order, so two transactions that move clients between the same partitions
-- cannot deadlock on them. A partition with no bounds row is closed, and a
-- change to it is dropped. A row with no count stays without one until the
-- recount sets it.
CREATE FUNCTION exomem_oauth_client_partition_add(p_partitions text[], p_deltas integer[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF cardinality(p_partitions) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM exomem_oauth_client_partition_bounds
  WHERE client_partition = ANY (p_partitions)
  ORDER BY client_partition
  FOR UPDATE;
  UPDATE exomem_oauth_client_partition_bounds AS bounds
  SET used = bounds.used + change.delta
  FROM unnest(p_partitions, p_deltas) AS change (client_partition, delta)
  WHERE bounds.client_partition = change.client_partition;
END;
$$;

-- One trigger function per event: a statement trigger with transition tables
-- names only the tables its event has. Each sums the statement's net change
-- per partition and writes only partitions that changed, so an update that
-- moves no client in or out of a partition (a context change, a metadata
-- refresh, an enable flip) never touches a counter row.
CREATE FUNCTION exomem_oauth_clients_count_inserted() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  partitions text[];
  deltas integer[];
BEGIN
  SELECT coalesce(array_agg(client_partition), '{}'), coalesce(array_agg(delta), '{}')
  INTO partitions, deltas
  FROM (
    SELECT exomem_oauth_client_partition_of(admission_mode, auto_registered, client_platform)
             AS client_partition,
           count(*)::integer AS delta
    FROM inserted_clients
    WHERE retired_at IS NULL
    GROUP BY 1
  ) AS change
  WHERE client_partition IS NOT NULL;
  PERFORM exomem_oauth_client_partition_add(partitions, deltas);
  RETURN NULL;
END;
$$;

CREATE FUNCTION exomem_oauth_clients_count_updated() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  partitions text[];
  deltas integer[];
BEGIN
  SELECT coalesce(array_agg(client_partition), '{}'), coalesce(array_agg(delta), '{}')
  INTO partitions, deltas
  FROM (
    SELECT client_partition, sum(delta)::integer AS delta
    FROM (
      SELECT exomem_oauth_client_partition_of(admission_mode, auto_registered, client_platform)
               AS client_partition,
             1 AS delta
      FROM updated_clients_after
      WHERE retired_at IS NULL
      UNION ALL
      SELECT exomem_oauth_client_partition_of(admission_mode, auto_registered, client_platform),
             -1
      FROM updated_clients_before
      WHERE retired_at IS NULL
    ) AS moved
    GROUP BY client_partition
    HAVING sum(delta) <> 0
  ) AS change
  WHERE client_partition IS NOT NULL;
  PERFORM exomem_oauth_client_partition_add(partitions, deltas);
  RETURN NULL;
END;
$$;

CREATE FUNCTION exomem_oauth_clients_count_deleted() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  partitions text[];
  deltas integer[];
BEGIN
  SELECT coalesce(array_agg(client_partition), '{}'), coalesce(array_agg(delta), '{}')
  INTO partitions, deltas
  FROM (
    SELECT exomem_oauth_client_partition_of(admission_mode, auto_registered, client_platform)
             AS client_partition,
           -count(*)::integer AS delta
    FROM deleted_clients
    WHERE retired_at IS NULL
    GROUP BY 1
  ) AS change
  WHERE client_partition IS NOT NULL;
  PERFORM exomem_oauth_client_partition_add(partitions, deltas);
  RETURN NULL;
END;
$$;

CREATE FUNCTION exomem_oauth_clients_count_truncated() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE exomem_oauth_client_partition_bounds SET used = 0, recounted_at = now();
  RETURN NULL;
END;
$$;

-- Clients statements first, as 0067 orders them. Creating the triggers locks
-- the clients table against writes until this file commits, so the backfill
-- below counts a population that no registration can change before the
-- triggers take over.
CREATE TRIGGER exomem_oauth_clients_count_inserted
  AFTER INSERT ON exomem_oauth_clients
  REFERENCING NEW TABLE AS inserted_clients
  FOR EACH STATEMENT EXECUTE FUNCTION exomem_oauth_clients_count_inserted();
CREATE TRIGGER exomem_oauth_clients_count_updated
  AFTER UPDATE ON exomem_oauth_clients
  REFERENCING OLD TABLE AS updated_clients_before NEW TABLE AS updated_clients_after
  FOR EACH STATEMENT EXECUTE FUNCTION exomem_oauth_clients_count_updated();
CREATE TRIGGER exomem_oauth_clients_count_deleted
  AFTER DELETE ON exomem_oauth_clients
  REFERENCING OLD TABLE AS deleted_clients
  FOR EACH STATEMENT EXECUTE FUNCTION exomem_oauth_clients_count_deleted();
CREATE TRIGGER exomem_oauth_clients_count_truncated
  AFTER TRUNCATE ON exomem_oauth_clients
  FOR EACH STATEMENT EXECUTE FUNCTION exomem_oauth_clients_count_truncated();

-- used NULL means not counted yet: a bounds row that an operator adds has no
-- count, so its partition admits no new client and the headroom read fails
-- until the next sweep recounts it, rather than admitting up to the bound on a
-- count of zero. recounted_at NULL means never recounted, which makes the row
-- due. No CHECK on used: a counter that drifted below zero must not fail the
-- registration or retirement that reveals it. The recount corrects it.
ALTER TABLE exomem_oauth_client_partition_bounds
  ADD COLUMN used integer,
  ADD COLUMN recounted_at timestamptz;

UPDATE exomem_oauth_client_partition_bounds AS bounds
SET used = (
      SELECT count(*)::integer
      FROM exomem_oauth_clients AS client
      WHERE client.retired_at IS NULL
        AND client.admission_mode <> 'first_party'
        AND exomem_oauth_client_partition_of(
              client.admission_mode, client.auto_registered, client.client_platform
            ) = bounds.client_partition
    ),
    recounted_at = now();

-- Same signature: the admission gates, the operator headroom report and any
-- instance still on the previous release read the maintained counters.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partitions()
RETURNS TABLE (client_partition text, bound integer, used integer)
LANGUAGE sql STABLE AS $$
  SELECT client_partition, bound, used FROM exomem_oauth_client_partition_bounds
$$;

COMMENT ON FUNCTION exomem_oauth_client_partitions() IS
  'Client population partitions (operator, auto_registered CIMD, generic), '
  'each with its bound and its maintained count of unretired clients from '
  'exomem_oauth_client_partition_bounds, NULL before its first count. The '
  'admission gates and the operator headroom report both read it.';

-- Whether p_client_id may take a slot in p_partition. A row that already
-- holds one there needs no new slot. Otherwise the partition's row is locked
-- until the caller commits, together with the partition the row would leave,
-- in name order. The insert's trigger counts the new client under that lock,
-- so a concurrent registration waits and then reads the new count: the bound
-- is never passed. Volatile, because it locks.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partition_available_for(
  p_client_id text,
  p_partition text
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  current_partition text;
  free boolean;
BEGIN
  SELECT exomem_oauth_client_partition_of(admission_mode, auto_registered, client_platform)
  INTO current_partition
  FROM exomem_oauth_clients
  WHERE client_id = p_client_id AND retired_at IS NULL;
  IF current_partition = p_partition THEN
    RETURN true;
  END IF;
  PERFORM 1 FROM exomem_oauth_client_partition_bounds
  WHERE client_partition IN (p_partition, current_partition)
  ORDER BY client_partition
  FOR UPDATE;
  -- Read the row again under the lock: a concurrent registration of the same
  -- client that committed while this one waited already holds its slot, and
  -- the partition may now be full because of it.
  SELECT exomem_oauth_client_partition_of(admission_mode, auto_registered, client_platform)
  INTO current_partition
  FROM exomem_oauth_clients
  WHERE client_id = p_client_id AND retired_at IS NULL;
  IF current_partition = p_partition THEN
    RETURN true;
  END IF;
  SELECT used < bound INTO free
  FROM exomem_oauth_client_partition_bounds
  WHERE client_partition = p_partition;
  RETURN coalesce(free, false);
END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available_for(text, text) IS
  'Whether a client may take or keep a slot in a partition: it already holds '
  'one there, or the partition has one free. A new slot locks the partition''s '
  'bounds row until commit, so concurrent registrations never pass the bound.';

-- The operator gate keeps its contract: any unretired row of the client ID
-- keeps its slot, and otherwise the operator or auto-registered partition
-- must have one free.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partition_available(
  p_client_id text,
  p_auto_registered boolean
) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM exomem_oauth_clients
    WHERE client_id = p_client_id AND retired_at IS NULL
  ) THEN
    RETURN true;
  END IF;
  RETURN exomem_oauth_client_partition_available_for(
    p_client_id,
    CASE WHEN p_auto_registered THEN 'auto_registered' ELSE 'operator' END
  );
END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Whether an operator or auto-registered CIMD client may take or keep a slot: '
  'it already holds one, or its partition has one free. A retired client holds '
  'none.';

-- A generic registration always asks for a new slot: its identifier is
-- server-assigned and names no existing row.
CREATE OR REPLACE FUNCTION exomem_oauth_generic_client_partition_available()
RETURNS boolean
LANGUAGE sql
VOLATILE
AS $$
  SELECT exomem_oauth_client_partition_available_for(NULL, 'generic');
$$;

COMMENT ON FUNCTION exomem_oauth_generic_client_partition_available() IS
  'Whether the generic partition has a free slot for a new dynamically '
  'registered client. Locks the partition''s bounds row until commit.';

-- Sets one partition's counter to an exact count. The bounds row is locked
-- first, then counted in a new statement: a writer whose change is not yet
-- committed waits on the row and applies its change after the recount, and
-- every committed change is in the count. Skips a partition whose row a
-- registration holds, returning NULL; otherwise returns the drift corrected,
-- counting a row that had no count as zero.
-- What it prevents: a counter left wrong by a write that bypassed the
-- triggers (session_replication_role = replica, a restore with triggers
-- disabled, a bounds row added by hand). It costs one partition scan.
CREATE FUNCTION exomem_oauth_client_partition_recount(p_partition text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  counted integer;
  exact integer;
BEGIN
  SELECT used INTO counted
  FROM exomem_oauth_client_partition_bounds
  WHERE client_partition = p_partition
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- The first-party condition changes no result, since such a row has no
  -- partition. It matches the partial index's predicate, so the count reads
  -- unretired clients only, which the bounds cap, not every retired row.
  SELECT count(*)::integer INTO exact
  FROM exomem_oauth_clients AS client
  WHERE client.retired_at IS NULL
    AND client.admission_mode <> 'first_party'
    AND exomem_oauth_client_partition_of(
          client.admission_mode, client.auto_registered, client.client_platform
        ) = p_partition;
  UPDATE exomem_oauth_client_partition_bounds
  SET used = exact, recounted_at = now()
  WHERE client_partition = p_partition;
  RETURN exact - coalesce(counted, 0);
END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_recount(text) IS
  'Recounts one partition exactly and returns the drift it corrected, or NULL '
  'when a registration holds the partition. The OAuth sweep calls it hourly.';
