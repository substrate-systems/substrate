-- Release B preserves every identity UUID while making Exomem its only authority.
ALTER TABLE exomem_tenants
  DROP CONSTRAINT exomem_tenants_owner_user_id_fkey,
  ADD CONSTRAINT exomem_tenants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES exomem_users(id) ON DELETE RESTRICT;
ALTER TABLE exomem_sessions
  DROP CONSTRAINT exomem_sessions_user_id_fkey,
  ADD CONSTRAINT exomem_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES exomem_users(id) ON DELETE CASCADE;
ALTER TABLE exomem_access_tokens
  DROP CONSTRAINT exomem_access_tokens_user_id_fkey,
  ADD CONSTRAINT exomem_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES exomem_users(id) ON DELETE CASCADE;
ALTER TABLE exomem_invites
  DROP CONSTRAINT exomem_invites_consumed_by_user_id_fkey,
  ADD CONSTRAINT exomem_invites_consumed_by_user_id_fkey FOREIGN KEY (consumed_by_user_id) REFERENCES exomem_users(id) ON DELETE RESTRICT;
ALTER TABLE exomem_transfer_grants
  DROP CONSTRAINT exomem_transfer_grants_user_id_fkey,
  ADD CONSTRAINT exomem_transfer_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES exomem_users(id) ON DELETE CASCADE;
ALTER TABLE exomem_oauth_grants
  DROP CONSTRAINT exomem_oauth_grants_user_id_fkey,
  ADD CONSTRAINT exomem_oauth_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES exomem_users(id) ON DELETE CASCADE;
ALTER TABLE exomem_oauth_account_blocks
  DROP CONSTRAINT exomem_oauth_account_blocks_owner_user_id_fkey,
  ADD CONSTRAINT exomem_oauth_account_blocks_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES exomem_users(id) ON DELETE RESTRICT;
ALTER TABLE exomem_marketplace_reviewer_credentials
  DROP CONSTRAINT exomem_marketplace_reviewer_credentials_owner_user_id_fkey,
  ADD CONSTRAINT exomem_marketplace_reviewer_credentials_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES exomem_users(id) ON DELETE RESTRICT;
