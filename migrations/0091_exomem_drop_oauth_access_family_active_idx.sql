-- Migration 0091 — drop exomem_oauth_access_family_active_idx.
--
-- 0089 built this partial index for two readers: the sign-out sweep's third
-- driver, which the shipped query does not have, and live_until's per-family
-- access probe. The probe is also answered by 0067's unqualified
-- exomem_oauth_access_tokens_family_idx, so the index's only distinct service
-- is saving one heap fetch per probe — measured at about 10% write overhead
-- on the access-token table for that. The read saving is not worth the write
-- cost: drop it.
--
-- The runner applies this file in one transaction, and each table lock lasts
-- until it commits. A statement that waits for a lock blocks every request
-- queued behind it, so the migration fails after five seconds instead.
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS exomem_oauth_access_family_active_idx;
