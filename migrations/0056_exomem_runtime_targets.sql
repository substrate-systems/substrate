-- A verified provisioning target is independent from any observed cell. The
-- candidate remains the lifecycle authority; this record only pins the exact
-- reviewed runtime identity used while the fleet is empty.

CREATE TABLE exomem_runtime_targets (
  candidate_id uuid PRIMARY KEY REFERENCES exomem_agent_contract_candidates(id) ON DELETE RESTRICT,
  release_version text NOT NULL,
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
  runtime_image text NOT NULL,
  runtime_candidate_sha256 text NOT NULL CHECK (runtime_candidate_sha256 ~ '^[a-f0-9]{64}$'),
  protocol_version text NOT NULL,
  agent_profile text NOT NULL,
  gateway_contract_digest text NOT NULL CHECK (gateway_contract_digest ~ '^[a-f0-9]{64}$'),
  command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  compatibility_digest text NOT NULL CHECK (compatibility_digest ~ '^[a-f0-9]{64}$'),
  runtime_target_digest text NOT NULL CHECK (runtime_target_digest ~ '^[a-f0-9]{64}$'),
  verification_manifest_digest text NOT NULL CHECK (verification_manifest_digest ~ '^[a-f0-9]{64}$'),
  imported_by_principal_digest bytea NOT NULL CHECK (octet_length(imported_by_principal_digest) = 32),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, runtime_target_digest, verification_manifest_digest)
);

CREATE INDEX exomem_runtime_targets_identity_idx
  ON exomem_runtime_targets (
    release_version, agent_profile, protocol_version, command_fingerprint,
    schema_digest, compatibility_digest
  );
