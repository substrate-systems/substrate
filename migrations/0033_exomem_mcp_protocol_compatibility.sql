-- MCP transport compatibility is promoted with the candidate, never inferred at request time.
ALTER TABLE exomem_agent_contract_candidates
  ADD COLUMN mcp_protocol_versions jsonb;

-- Only the reviewed legacy Hosted contract can receive the pinned transport
-- compatibility identity. Other legacy rows remain fail-closed until re-imported.
UPDATE exomem_agent_contract_candidates
SET mcp_protocol_versions = '["2025-11-25", "2025-06-18"]'::jsonb
WHERE mcp_protocol_versions IS NULL
  AND profile_id = 'hosted-alpha-agent-v1'
  AND endpoint = 'https://substratesystems.io/api/exomem/mcp/v1'
  AND source_release = '0.33.0'
  AND protocol_version = '1';

CREATE FUNCTION exomem_mcp_protocol_versions_are_valid(versions jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(versions) <> 'array' THEN false
    WHEN jsonb_array_length(versions) NOT BETWEEN 1 AND 8 THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(versions) AS protocols(version)
      WHERE jsonb_typeof(version) <> 'string'
         OR version #>> '{}' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
    )
    AND (
      SELECT count(*) = count(DISTINCT version #>> '{}')
      FROM jsonb_array_elements(versions) AS protocols(version)
    )
  END
$$;

ALTER TABLE exomem_agent_contract_candidates
  ADD CONSTRAINT exomem_agent_contract_candidates_mcp_protocol_versions_check
  CHECK (
    mcp_protocol_versions IS NULL
    OR exomem_mcp_protocol_versions_are_valid(mcp_protocol_versions)
  );
