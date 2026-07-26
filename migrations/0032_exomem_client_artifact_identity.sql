-- Bind future OpenAI artifact evidence to the exact reviewed contract candidate.

ALTER TABLE exomem_client_artifacts
  ADD COLUMN contract_candidate_id uuid REFERENCES exomem_agent_contract_candidates(id) ON DELETE RESTRICT,
  ADD COLUMN registered_app_id_sha256 text CHECK (
    registered_app_id_sha256 IS NULL OR registered_app_id_sha256 ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE exomem_client_artifacts
  ADD CONSTRAINT exomem_client_artifacts_openai_contract_identity_check
  CHECK (
    platform <> 'openai'
    OR (contract_candidate_id IS NOT NULL AND registered_app_id_sha256 IS NOT NULL)
  ) NOT VALID;
