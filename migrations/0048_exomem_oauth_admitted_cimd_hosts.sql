-- Host-allowlisted CIMD client admission.
--
-- Live-cohort admission compares a client's oauth_client_config_sha256 against a
-- single pinned digest per platform carried on exomem_hosted_alpha_cohort. Every
-- ChatGPT connector has its own connectorId, therefore its own client.json,
-- therefore its own digest -- so at most one ChatGPT connector could ever be
-- admitted. This table is the operator-curated alternative: a client is eligible
-- on the strength of the host serving its metadata document.
--
-- The allowlist lives in the database rather than in EXOMEM_CIMD_ALLOWED_HOSTS
-- because the admission predicate is evaluated in SQL in six separate queries.
-- The env var keeps its existing job of gating operator registration; this table
-- governs admission. It is keyed by (platform, host) because auto-registration
-- must assign client_platform, and the host is the only signal available at
-- first contact.

CREATE TABLE exomem_oauth_admitted_cimd_hosts (
  platform text NOT NULL,
  host text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, host),
  CONSTRAINT exomem_oauth_admitted_cimd_hosts_platform_valid
    CHECK (platform IN ('claude', 'openai')),
  CONSTRAINT exomem_oauth_admitted_cimd_hosts_host_valid
    CHECK (host = lower(host) AND host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);

INSERT INTO exomem_oauth_admitted_cimd_hosts (platform, host)
VALUES ('openai', 'chatgpt.com')
ON CONFLICT DO NOTHING;

-- Provenance is explicit rather than inferred from admission_mode, because
-- operator-registered clients are also admission_mode = 'cimd'. Without this
-- column an auto-registration upsert could overwrite a bootstrap-pinned client.
ALTER TABLE exomem_oauth_clients
  ADD COLUMN auto_registered boolean NOT NULL DEFAULT false;

CREATE INDEX exomem_oauth_clients_auto_registered_idx
  ON exomem_oauth_clients (auto_registered)
  WHERE auto_registered;

-- The population bound partitions by provenance. A full auto-registration
-- partition must never stop an operator registering a client, which is what a
-- single raised cap would have allowed: an unauthenticated caller could consume
-- every slot and convert a storage bound into a control-plane outage.
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
    ) < CASE WHEN p_auto_registered THEN 128 ELSE 32 END;
$$;

COMMENT ON FUNCTION exomem_oauth_client_partition_available(text, boolean) IS
  'Population bound for exomem_oauth_clients, partitioned by provenance. Operator '
  'clients keep their original bound of 32; auto-registered CIMD clients get a '
  'separate 128 so anonymous registration cannot exhaust operator slots.';
