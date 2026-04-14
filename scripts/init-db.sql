-- Endstate license management schema
-- Run against Vercel Postgres (Neon):
--   psql "$DATABASE_URL" -f scripts/init-db.sql

CREATE TABLE IF NOT EXISTS licenses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key            text UNIQUE NOT NULL,
  email                  text NOT NULL,
  paddle_transaction_id  text UNIQUE NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id    uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  fingerprint   text NOT NULL,
  machine_name  text,
  instance_id   text UNIQUE NOT NULL,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (license_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS devices_license_id_idx ON devices (license_id);
