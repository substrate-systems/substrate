-- Migration 0004 — signing_keys
-- Hosted Backup v2 (PR1: add-hosted-backup-auth). Contract: ../hosted-backup-contract.md §4.
--
-- Stores public keys only. The active private key is loaded from environment
-- variables ENDSTATE_JWT_PRIVATE_KEY_HEX + ENDSTATE_JWT_ACTIVE_KID at cold start
-- (mirrors the pattern in src/lib/license/crypto.ts).
--
-- This table powers JWKS publication and "kid lookup" during JWT verification,
-- including a 24h grace window for recently-retired kids so in-flight tokens
-- (15-min lifetime) survive a rotation.

CREATE TABLE signing_keys (
  kid text PRIMARY KEY,
  public_key bytea NOT NULL,
  algorithm text NOT NULL DEFAULT 'EdDSA',
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE INDEX signing_keys_retired_idx ON signing_keys (retired_at);
