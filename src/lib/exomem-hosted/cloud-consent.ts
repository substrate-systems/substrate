/**
 * Cloud design D2 "Deletion revokes consent": the transaction that sets a
 * tenant's Cloud cell row to `deleted` -- through the unpaid-invite expiry,
 * lifecycle reconcile or account deletion -- also revokes that tenant's OAuth
 * grants, their refresh-token families and their access tokens. A
 * re-admitted tenant's new cell is then reachable only after fresh consent,
 * never through a token issued for the cell that was deleted.
 *
 * Every grant the tenant holds is revoked, not only those naming the Cloud
 * resource URL: under Cloud that is the only resource a tenant can reach,
 * and keying on the tenant alone means a deletion never depends on Cloud
 * configuration being present. A missing setting must not leave a deleted
 * tenant's tokens live.
 */

import { executeExomemSql, type ExomemSql } from "./db";

export async function revokeCloudResourceConsent(tx: ExomemSql, tenantId: string): Promise<void> {
  // One statement: every data-modifying CTE sees the same snapshot, so the
  // family and token updates still find their grants even though
  // `revoked_grants` changes those grant rows in the same statement.
  await tx`
    /* exomem-cloud:revoke-deleted-cell-consent */
    WITH cloud_grants AS (
      SELECT id FROM exomem_oauth_grants WHERE tenant_id = ${tenantId}::uuid
    ),
    revoked_grants AS (
      UPDATE exomem_oauth_grants AS grant_row
      SET revoked_at = now(), updated_at = now()
      FROM cloud_grants
      WHERE grant_row.id = cloud_grants.id AND grant_row.revoked_at IS NULL
      RETURNING grant_row.id
    ),
    revoked_families AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = now(),
          revoked_reason = COALESCE(family.revoked_reason, 'cloud_cell_deleted')
      FROM cloud_grants
      WHERE family.grant_id = cloud_grants.id AND family.revoked_at IS NULL
      RETURNING family.id
    ),
    revoked_tokens AS (
      UPDATE exomem_oauth_access_tokens AS token
      SET revoked_at = now()
      FROM cloud_grants
      WHERE token.grant_id = cloud_grants.id AND token.revoked_at IS NULL
      RETURNING token.id
    )
    SELECT (SELECT count(*) FROM revoked_grants) AS grants,
           (SELECT count(*) FROM revoked_families) AS families,
           (SELECT count(*) FROM revoked_tokens) AS tokens
  `;
}

/**
 * An owner disconnects one app. The grant, every refresh-token family and
 * access token under it, and any code not yet exchanged are revoked in one
 * statement, so the app's next token use and its next refresh are refused.
 *
 * Fenced to the owner's own user and tenant: a grant id from another account
 * matches nothing. Returns whether the grant is the owner's, whether it was
 * revoked now or earlier, so a repeated disconnect still succeeds.
 */
export async function revokeOwnerOAuthGrant(input: {
  userId: string;
  tenantId: string;
  grantId: string;
}): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:revoke-owner-oauth-grant */
    WITH owned AS (
      SELECT oauth_grant.id
      FROM exomem_oauth_grants AS oauth_grant
      JOIN exomem_tenants AS tenant
        ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
      WHERE oauth_grant.id = ${input.grantId}::uuid
        AND oauth_grant.user_id = ${input.userId}::uuid
        AND oauth_grant.tenant_id = ${input.tenantId}::uuid
    ),
    revoked_grant AS (
      UPDATE exomem_oauth_grants AS grant_row
      SET revoked_at = now(), updated_at = now()
      FROM owned
      WHERE grant_row.id = owned.id AND grant_row.revoked_at IS NULL
      RETURNING grant_row.id
    ),
    revoked_families AS (
      UPDATE exomem_oauth_token_families AS family
      SET revoked_at = now(),
          revoked_reason = COALESCE(family.revoked_reason, 'owner_disconnected')
      FROM owned
      WHERE family.grant_id = owned.id AND family.revoked_at IS NULL
      RETURNING family.id
    ),
    revoked_tokens AS (
      UPDATE exomem_oauth_access_tokens AS token
      SET revoked_at = now()
      FROM owned
      WHERE token.grant_id = owned.id AND token.revoked_at IS NULL
      RETURNING token.id
    ),
    spent_codes AS (
      UPDATE exomem_oauth_authorization_codes AS code
      SET consumed_at = now()
      FROM owned
      WHERE code.grant_id = owned.id AND code.consumed_at IS NULL
      RETURNING code.id
    )
    SELECT (SELECT count(*) FROM owned)::int AS owned
  `;
  return Number(rows[0]?.owned ?? 0) === 1;
}
