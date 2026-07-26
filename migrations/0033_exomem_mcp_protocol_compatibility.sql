-- MCP transport compatibility is promoted with the candidate, never inferred at request time.
ALTER TABLE exomem_agent_contract_candidates
  ADD COLUMN mcp_protocol_versions jsonb;

ALTER TABLE exomem_agent_contract_candidates
  ADD CONSTRAINT exomem_agent_contract_candidates_mcp_protocol_versions_check
  CHECK (
    mcp_protocol_versions IS NULL
    OR (
      jsonb_typeof(mcp_protocol_versions) = 'array'
      AND jsonb_array_length(mcp_protocol_versions) BETWEEN 1 AND 8
    )
  );
