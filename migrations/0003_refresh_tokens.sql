-- Migration 0003 — refresh_tokens
-- Hosted Backup v2 (PR1: add-hosted-backup-auth). Contract: ../hosted-backup-contract.md §5.
--
-- token_hash is SHA-256(opaque token bytes). The opaque token itself never reaches the DB.
--
-- chain_id groups all refresh tokens that descend from a single login. Reuse detection
-- works by revoking the entire chain when an already-revoked token is presented.
--
-- parent_id points at the token this one rotated from (NULL for chain roots).

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain_id uuid NOT NULL,
  parent_id uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  token_hash bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX refresh_tokens_user_expires_idx ON refresh_tokens (user_id, expires_at);
CREATE INDEX refresh_tokens_chain_idx ON refresh_tokens (chain_id);
