-- Migration 0002 — auth_credentials
-- Hosted Backup v2 (PR1: add-hosted-backup-auth). Contract: ../hosted-backup-contract.md §2, §5, §6.
--
-- server_password_hash and recovery_key_verifier are argon2id PHC strings
-- ($argon2id$v=19$m=...,t=...,p=...$<salt-base64>$<hash-base64>). The PHC string
-- already encodes the per-row salt and cost parameters, so no separate server_salt column.
--
-- client_salt is the per-user 16-byte salt the CLIENT uses when running Argon2id
-- over the user's passphrase. Returned by login step-1 so the client can derive the
-- same serverPassword + masterKey it derived at signup.
--
-- kdf_params records the parameters used at signup so the client uses the same on
-- subsequent logins (forward-compatible parameter upgrades).
--
-- wrapped_dek is the AES-256-GCM-wrapped data-encryption-key, wrapped with the
-- client's masterKey. Server cannot decrypt.
--
-- recovery_key_wrapped_dek is the same DEK, separately wrapped with the
-- recovery key. The two wrappings are independent unlock paths.

CREATE TABLE auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  server_password_hash text NOT NULL,
  client_salt bytea NOT NULL,
  kdf_params jsonb NOT NULL,
  wrapped_dek bytea NOT NULL,
  recovery_key_verifier text NOT NULL,
  recovery_key_wrapped_dek bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
