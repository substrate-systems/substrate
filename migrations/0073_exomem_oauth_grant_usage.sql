-- When each connected app last reached its Exomem, for Home's app rows.
-- The gateway writes it on a forwarded request. It lives beside the grants,
-- not on them, so the gateway keeps no write on any OAuth table.
CREATE TABLE exomem_oauth_grant_usage (
  grant_id uuid PRIMARY KEY REFERENCES exomem_oauth_grants(id) ON DELETE CASCADE,
  last_used_at timestamptz NOT NULL
);
