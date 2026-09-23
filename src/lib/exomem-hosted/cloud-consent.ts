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

import type { ExomemSql } from "./db";

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
