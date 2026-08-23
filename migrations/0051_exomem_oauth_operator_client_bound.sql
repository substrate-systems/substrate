-- Raise the operator client partition bound from 32 to 96.
--
-- The bound is a population limit on exomem_oauth_clients, partitioned by
-- provenance. What that partitioning buys is the security property: anonymous
-- CIMD registration gets its own 128 and therefore cannot exhaust the slots an
-- operator needs. The specific number on the operator side was never load
-- bearing -- migration 0048's own comment calls it "their original bound".
--
-- It became load bearing by accident, because nothing ever frees a slot. Each
-- reviewer bootstrap attempt registers one pinned client, and a client carrying
-- bootstrap history can never be re-enabled or repurposed, so every attempt --
-- successful or abandoned -- leaves a permanent tombstone. Two weeks of
-- promotion windows filled the partition to 32/32, and with no reclaim path in
-- any code (the only DELETE FROM exomem_oauth_clients in the tree is in tests)
-- the first promotion of the alpha could not proceed at all: preflight reports
-- "<=0 of 32 operator slot(s) free. Nothing reclaims a slot through the API."
--
-- 96 buys room for the promotion windows the alpha needs without pretending the
-- underlying problem is solved. It is not: a bound with no reclaim path is a
-- capacity time bomb rather than a control, and the same defect sits on the
-- CIMD side, where pruneExpiredOAuthState disables an expired client
-- (SET enabled = false) but never deletes the row while the count that gates
-- admission is count(*) regardless of enabled. That side is worse because it
-- meters legitimate growth: after 128 distinct client ids from admitted hosts
-- have ever connected, CIMD admission shuts permanently. Reclaim is being
-- specified separately; this migration only buys the room to run the window.
CREATE OR REPLACE FUNCTION exomem_oauth_client_partition_available(
  p_client_id text,
  p_auto_registered boolean
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
      SELECT 1 FROM exomem_oauth_clients WHERE client_id = p_client_id
    )
    OR (
      SELECT count(*)
      FROM exomem_oauth_clients
      WHERE auto_registered = p_auto_registered
    ) < CASE WHEN p_auto_registered THEN 128 ELSE 96 END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Population bound for exomem_oauth_clients, partitioned by provenance. Operator '
  'clients are bounded at 96; auto-registered CIMD clients get a separate 128 so '
  'anonymous registration cannot exhaust operator slots. Neither partition has a '
  'reclaim path: an expired CIMD client is disabled but its row still counts, and '
  'a spent bootstrap client is never removed at all.';
