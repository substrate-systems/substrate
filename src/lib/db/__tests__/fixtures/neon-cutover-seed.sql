-- Representative rows for the Neon cutover rehearsal (task 4.1). Run on the
-- stand-in Neon source after every migration, as the role that ran the
-- migrations. At least one row lands in every table that carries Endstate,
-- Paddle or OAuth state, so the dump, restore and verify prove each of them.
--
-- The schema of record has no numeric column and no sequence, so the probe
-- table at the end supplies both, plus the other types whose text rendering
-- the verify checksum depends on.

-- Endstate accounts and credentials.
INSERT INTO users (id, email, email_verified_at, created_at) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Endstate.User@Example.test', '2026-05-03 10:00:00+02', '2026-05-03 09:59:00+02'),
  ('00000000-0000-4000-8000-000000000002', 'exomem.owner@example.test', '2026-08-01 12:00:00+00', '2026-08-01 11:00:00+00'),
  ('00000000-0000-4000-8000-000000000003', 'deleted.tenant@example.test', NULL, '2026-07-01 08:00:00+00');

INSERT INTO auth_credentials (
  user_id, server_password_hash, client_salt, kdf_params, wrapped_dek,
  recovery_key_verifier, recovery_key_wrapped_dek
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g',
  '\x00112233445566778899aabbccddeeff',
  '{"algorithm": "argon2id", "memory": 65536, "iterations": 3, "parallelism": 4}',
  '\x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff',
  'recovery-verifier-base64==',
  '\xdeadbeef00000000deadbeef00000000'
);

INSERT INTO refresh_tokens (id, user_id, chain_id, parent_id, token_hash, issued_at, expires_at) VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000100', NULL, '\x0101010101010101010101010101010101010101010101010101010101010101',
   '2026-09-01 00:00:00+00', '2026-10-01 00:00:00+00'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101',
   '\x0202020202020202020202020202020202020202020202020202020202020202',
   '2026-09-15 00:00:00+00', '2026-10-15 00:00:00+00');

INSERT INTO signing_keys (kid, public_key, algorithm, created_at) VALUES
  ('rehearsal-2026-09', '\x3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29', 'EdDSA', '2026-09-01 00:00:00+00');

INSERT INTO account_sessions (session_id, user_id, expires_at) VALUES
  ('acct-session-rehearsal-1', '00000000-0000-4000-8000-000000000001', '2026-12-31 23:59:59+00');

INSERT INTO claim_tokens (token_hash, user_id, email, expires_at, source_event_id) VALUES
  ('\x0303030303030303030303030303030303030303030303030303030303030303',
   '00000000-0000-4000-8000-000000000001', 'ENDSTATE.user@example.test', '2026-10-01 00:00:00+00', 'evt_01rehearsalclaim');

INSERT INTO recovery_tokens_used (jti, user_id) VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001');

INSERT INTO redeemed_browser_session_jtis (jti) VALUES ('00000000-0000-4000-8000-000000000202');

INSERT INTO audit_log_account_deletions (user_id_hash, reason) VALUES
  ('\x0404040404040404040404040404040404040404040404040404040404040404', 'user_request');

-- Endstate backups: one committed version with two chunks.
INSERT INTO backups (id, user_id, name) VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001', 'Laptop — main, "quoted" \ backslash');

INSERT INTO backup_versions (
  id, backup_id, size_bytes, manifest_object_key, manifest_sha256, chunk_count,
  committed_at, client_operation_id, manifest_size_bytes
) VALUES (
  '00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000301', 123456789012,
  'users/00000000-0000-4000-8000-000000000001/manifests/v1',
  '\x0505050505050505050505050505050505050505050505050505050505050505', 2,
  '2026-09-20 03:00:00+00', 'op-rehearsal-1', 4096
);

INSERT INTO backup_chunks (version_id, chunk_index, object_key, size_bytes, sha256) VALUES
  ('00000000-0000-4000-8000-000000000302', 0, 'users/00000000-0000-4000-8000-000000000001/chunks/0', 1048576,
   '\x0606060606060606060606060606060606060606060606060606060606060606'),
  ('00000000-0000-4000-8000-000000000302', 1, 'users/00000000-0000-4000-8000-000000000001/chunks/1', 512,
   '\x0707070707070707070707070707070707070707070707070707070707070707');

INSERT INTO backup_version_operations (
  user_id, backup_id, operation_id, version_id, manifest_size_bytes, manifest_sha256, chunk_metadata, committed_at
) VALUES (
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000301', 'op-rehearsal-1',
  '00000000-0000-4000-8000-000000000302', 4096,
  '\x0505050505050505050505050505050505050505050505050505050505050505',
  '[{"index": 0, "encryptedSize": 1048576, "sha256": "06"}, {"index": 1, "encryptedSize": 512, "sha256": "07"}]',
  '2026-09-20 03:00:00+00'
);

INSERT INTO r2_purge_queue (r2_prefix) VALUES ('users/00000000-0000-4000-8000-000000000009/');

INSERT INTO rate_limit_events (scope, key, at) VALUES ('auth.login', 'ip:203.0.113.7', '2026-09-22 18:30:00+00');

-- Paddle: Endstate subscription state, the webhook dedupe ledger, and supporters.
INSERT INTO subscriptions (
  user_id, paddle_subscription_id, paddle_customer_id, status, current_period_end, plan,
  provider_event_id, provider_event_occurred_at
) VALUES (
  '00000000-0000-4000-8000-000000000001', 'sub_01rehearsalendstate', 'ctm_01rehearsalendstate', 'active',
  '2026-10-20 00:00:00+00', 'monthly', 'evt_01rehearsalsubscription', '2026-09-20 00:00:00+00'
);

INSERT INTO paddle_webhook_events (event_id, event_type, received_at, processed_at, attempt_count) VALUES
  ('evt_01rehearsalprocessed', 'subscription.updated', '2026-09-20 00:00:01+00', '2026-09-20 00:00:02+00', 1);

INSERT INTO paddle_cancellation_tombstones (user_id_hash, paddle_subscription_id) VALUES
  ('\x0808080808080808080808080808080808080808080808080808080808080808', 'sub_01rehearsalcancelled');

INSERT INTO supporter_contributions (paddle_transaction_id, paddle_event_id, tier, customer_email) VALUES
  ('txn_01rehearsalsupporter', 'evt_01rehearsalsupporter', 'patron', 'supporter@example.test');

INSERT INTO supporter_email_outbox (paddle_transaction_id, kind, sent_at) VALUES
  ('txn_01rehearsalsupporter', 'supporter_thank_you', '2026-09-20 00:05:00+00');

-- Exomem tenants, entitlements and Paddle provenance.
INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state) VALUES
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000002', 'active', 'running');
INSERT INTO exomem_tenants (id, owner_user_id, status, desired_state, deleted_at) VALUES
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000003', 'deleted', 'deleted', '2026-09-01 00:00:00+00');

INSERT INTO exomem_entitlements (
  tenant_id, source, source_state, effective_state, capabilities, resource_limits, source_occurred_at,
  provider_customer_ref, provider_subscription_ref, provider_transaction_ref, provider_environment
) VALUES (
  '00000000-0000-4000-8000-000000000401', 'paddle', 'active', 'active', '["capture", "recall"]',
  '{"storage_gib": 5}', '2026-08-01 12:00:00+00',
  'ctm_01rehearsalexomem', 'sub_01rehearsalexomem', 'txn_01rehearsalexomem', 'production'
);

INSERT INTO exomem_paddle_events (paddle_event_id, environment, event_type, tenant_id, occurred_at, applied_at, disposition) VALUES
  ('evt_01rehearsalexomem', 'live', 'subscription.activated', '00000000-0000-4000-8000-000000000401',
   '2026-08-01 12:00:00+00', '2026-08-01 12:00:05+00', 'applied');

INSERT INTO exomem_sessions (id, user_id, tenant_id, session_digest, csrf_digest, expires_at) VALUES (
  '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000401',
  '\x0909090909090909090909090909090909090909090909090909090909090909',
  '\x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a', '2026-12-31 00:00:00+00'
);

-- One consumed paid invite, and one open complimentary invite that the
-- admission dry run redeems inside a rolled-back transaction.
INSERT INTO exomem_invites (
  id, token_digest, email_normalized, entitlement_source, created_by_principal_digest, expires_at,
  consumed_at, consumed_by_user_id, redeemed_tenant_id, redeemed_session_id
) VALUES (
  '00000000-0000-4000-8000-000000000601',
  '\x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'exomem.owner@example.test', 'paddle',
  '\x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c', '2026-12-31 00:00:00+00',
  '2026-08-01 11:30:00+00', '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000501'
);
INSERT INTO exomem_invites (
  id, token_digest, email_normalized, entitlement_source, entitlement_capabilities,
  created_by_principal_digest, expires_at
) VALUES (
  '00000000-0000-4000-8000-000000000602',
  '\x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d', 'dry-run.admission@example.test',
  'complimentary', '["capture", "recall"]',
  '\x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c', now() + interval '30 days'
);

-- OAuth: a CIMD client, and one complete authorization chain.
INSERT INTO exomem_oauth_clients (
  id, client_id, admission_mode, enabled, redirect_uris, redirect_uris_digest,
  metadata_document_digest, metadata_fetched_at, metadata_ttl_seconds, metadata_expires_at,
  cimd_host, client_platform, oauth_client_config_sha256
) VALUES (
  '00000000-0000-4000-8000-000000000701', 'https://claude.ai/oauth/rehearsal-client.json', 'cimd', true,
  '["https://claude.ai/api/mcp/auth_callback"]',
  digest(convert_to('["https://claude.ai/api/mcp/auth_callback"]'::jsonb::text, 'utf8'), 'sha256'),
  '\x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e', '2026-09-22 00:00:00+00', 3600,
  '2026-09-22 01:00:00+00', 'claude.ai', 'claude', repeat('ab', 32)
);

INSERT INTO exomem_oauth_authorization_transactions (
  id, transaction_digest, client_id, redirect_uri, resource, requested_scopes, state_digest, pkce_challenge,
  redeemed_session_id, expires_at, created_at, consumed_at, state_envelope, form_nonce_digest, continuation_binding
) VALUES (
  '00000000-0000-4000-8000-000000000702',
  '\x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f', '00000000-0000-4000-8000-000000000701',
  'https://claude.ai/api/mcp/auth_callback', 'https://cloud.example.test/mcp/v1', '{exomem.read,exomem.write}',
  '\x1010101010101010101010101010101010101010101010101010101010101010', repeat('p', 43),
  '00000000-0000-4000-8000-000000000501', '2026-09-22 00:10:00+00', '2026-09-22 00:00:00+00',
  '2026-09-22 00:01:00+00', '{"state": "opaque", "nested": {"unicode": "ünïcödé", "n": 1.5}}',
  '\x1111111111111111111111111111111111111111111111111111111111111111',
  '\x1212121212121212121212121212121212121212121212121212121212121212'
);

INSERT INTO exomem_oauth_grants (id, user_id, tenant_id, client_id, resource, scopes, authorization_transaction_id) VALUES (
  '00000000-0000-4000-8000-000000000703', '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000701',
  'https://cloud.example.test/mcp/v1', '{exomem.read,exomem.write}', '00000000-0000-4000-8000-000000000702'
);

INSERT INTO exomem_oauth_authorization_codes (
  code_digest, grant_id, client_id, redirect_uri, resource, pkce_challenge, expires_at, created_at, consumed_at
) VALUES (
  '\x1313131313131313131313131313131313131313131313131313131313131313', '00000000-0000-4000-8000-000000000703',
  '00000000-0000-4000-8000-000000000701', 'https://claude.ai/api/mcp/auth_callback',
  'https://cloud.example.test/mcp/v1', repeat('p', 43), '2026-09-22 00:02:00+00', '2026-09-22 00:01:00+00',
  '2026-09-22 00:01:30+00'
);

INSERT INTO exomem_oauth_token_families (id, grant_id, client_id, expires_at) VALUES (
  '00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000703',
  '00000000-0000-4000-8000-000000000701', '2026-12-31 00:00:00+00'
);

INSERT INTO exomem_oauth_access_tokens (access_digest, grant_id, family_id, client_id, resource, scopes, expires_at) VALUES (
  '\x1414141414141414141414141414141414141414141414141414141414141414', '00000000-0000-4000-8000-000000000703',
  '00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000701',
  'https://cloud.example.test/mcp/v1', '{exomem.read,exomem.write}', '2026-12-31 00:00:00+00'
);

INSERT INTO exomem_oauth_refresh_tokens (id, refresh_digest, family_id, parent_refresh_token_id, expires_at, consumed_at) VALUES
  ('00000000-0000-4000-8000-000000000705', '\x1515151515151515151515151515151515151515151515151515151515151515',
   '00000000-0000-4000-8000-000000000704', NULL, '2026-12-31 00:00:00+00', '2026-09-22 00:20:00+00'),
  ('00000000-0000-4000-8000-000000000706', '\x1616161616161616161616161616161616161616161616161616161616161616',
   '00000000-0000-4000-8000-000000000704', '00000000-0000-4000-8000-000000000705', '2026-12-31 00:00:00+00', NULL);

INSERT INTO exomem_oauth_account_blocks (tenant_id, owner_user_id, blocked_reason) VALUES
  ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000003', 'lifecycle_deleted');

-- Exomem Cloud (C1-C1d) and the gateway's rate-limit buckets.
INSERT INTO exomem_cloud_capacity (node, cell_slots, attachments_used, observed_at) VALUES
  ('rehearsal-node-1', 10, 1, '2026-09-22 00:00:00+00');

INSERT INTO exomem_cloud_settings (key, value) VALUES
  ('cell_image', to_jsonb('ghcr.io/example/exomem-cell@sha256:' || repeat('c', 64)));

INSERT INTO exomem_cloud_cells (
  cell_id, tenant_id, desired_state, desired_image, observed_generation, observed_state, ready, node,
  volume_id, backup_key_wrapped, backup_key_version
) VALUES (
  'rehearsalcellaaa', '00000000-0000-4000-8000-000000000401', 'running',
  'ghcr.io/example/exomem-cell@sha256:' || repeat('c', 64), 1, 'running', true, 'rehearsal-node-1',
  'vol-rehearsal', '\x1717171717171717171717171717171717171717171717171717171717171717', 1
);

INSERT INTO exomem_rate_limit_buckets (scope, key_digest, admitted_count) VALUES
  ('exomem:oauth-token', repeat('d', 64), 3);

-- Probe table: numeric, float and interval rendering, NULLs, and a sequence.
CREATE TABLE cutover_rehearsal_types (
  id bigserial PRIMARY KEY,
  amount numeric(30, 9),
  unbounded numeric,
  ratio double precision,
  approx real,
  payload bytea,
  doc jsonb,
  label citext,
  at timestamptz,
  tags text[],
  span interval,
  note text
);

INSERT INTO cutover_rehearsal_types (amount, unbounded, ratio, approx, payload, doc, label, at, tags, span, note) VALUES
  (12345678901234567890.123456789, 'NaN', 0.1, 3.14159, '\x00010203fffe', '{"b": [1, 2.50, "x"], "a": null}',
   'MiXeD Case', '2026-09-23 12:34:56.789012+05:30', '{alpha,"with space","quote\"d"}', '1 year 2 mons 3 days 04:05:06.789', E'line one\nline two\ttab'),
  (-0.000000001, 1e-300, 'Infinity', '-Infinity', '\x', '[]', 'ünïcödé', '1999-12-31 23:59:59+00', '{}', '-1 day', ''),
  (0, 123456789012345678901234567890.5, 'NaN', 1.17549435e-38, NULL, '{"deep": {"deeper": {"deepest": true}}}',
   NULL, 'infinity', NULL, '0', NULL),
  (NULL, NULL, -0.0, NULL, '\xdeadbeef', NULL, 'last', '-infinity', '{NULL,x}', NULL, 'back\slash');
