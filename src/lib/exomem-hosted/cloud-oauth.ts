/**
 * Exomem Cloud OAuth client admission and exact-resource token binding
 * (design D2, `adopt-exomem-cloud-plain-cells`).
 *
 * Additive and gated: nothing here is called from any hosted code path.
 * `resolveApprovedOAuthClient` and `findActiveOAuthAccessToken` /
 * `findMcpOAuthAccessToken` (oauth-store.ts) keep their whole-cohort EXISTS
 * and reviewer-credential branches entirely unchanged — Cloud admission is a
 * parallel, narrower predicate matching D2 exactly:
 *
 *   "For the Cloud MCP resource, an OAuth client SHALL be admitted when it
 *    is enabled, its redirect URI matches its registered digest, and its
 *    CIMD metadata host is approved and fresh. Admission MUST NOT require a
 *    live cohort or a reviewer credential."
 *
 * A token is bound to exactly one resource, and is accepted only where its
 * resource is exactly equal to the resource being served. That is already
 * how the schema works — `exomem_oauth_access_tokens.resource` is a plain
 * text column and every lookup here filters on it exactly — so the
 * "exact resource equality" requirement composes with the existing hosted
 * lookup path (mcp.ts's `access.resource !== EXOMEM_HOSTED_RESOURCE` check)
 * without either side needing to know about the other's resource literal.
 */

import { executeExomemSql } from "./db";

/**
 * D2's scope rule: "A cell sees one fixed non-owner principal and cannot
 * enforce a read-only grant. A Cloud-resource grant therefore always
 * carries both exomem.read and exomem.write: an authorization request that
 * omits scope receives both; a request naming only a subset is refused with
 * invalid_scope." Returns the effective scope string to validate against
 * the ordinary (resource-neutral) `validateAuthorizationRequest`, or `null`
 * to signal invalid_scope. A request naming both, plus anything else
 * (e.g. offline_access), is returned unchanged -- validateAuthorizationRequest
 * still rejects an unsupported scope name on its own.
 */
export function resolveCloudAuthorizationScope(requestedScope: string): string | null {
  const requested = requestedScope.trim();
  if (!requested) return "exomem.read exomem.write";
  const scopes = new Set(requested.split(" ").filter(Boolean));
  if (!scopes.has("exomem.read") || !scopes.has("exomem.write")) return null;
  return requested;
}

export type ApprovedCloudOAuthClient = {
  id: string;
  clientId: string;
  redirectUris: string[];
  admissionMode: "pinned" | "cimd";
};

/**
 * Cloud client admission (D2): enabled, redirect digest match, and — for a
 * self-registering CIMD client — a fresh metadata document served from a
 * host on the operator-curated allowlist. No whole-cohort check, no
 * reviewer-credential branch: Cloud has no cohort or candidate concept.
 */
export async function resolveApprovedCloudOAuthClient(
  clientId: string
): Promise<ApprovedCloudOAuthClient | null> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:resolve-approved-oauth-client */
    SELECT id, client_id, redirect_uris, admission_mode
    FROM exomem_oauth_clients AS client
    WHERE client.client_id = ${clientId}
      AND redirect_uris_digest = digest(convert_to(redirect_uris::text, 'utf8'), 'sha256')
      AND admission_mode IN ('pinned', 'cimd')
      AND enabled = true
      AND (
        admission_mode = 'pinned'
        OR (
          metadata_document_digest IS NOT NULL
          AND metadata_fetched_at IS NOT NULL
          AND metadata_ttl_seconds BETWEEN 300 AND 604800
          AND metadata_expires_at > now()
          AND cimd_host IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
            WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
          )
        )
      )
    LIMIT 1
  `;
  const row = rows[0] as
    | { id: string; client_id: string; redirect_uris: string[]; admission_mode: "pinned" | "cimd" }
    | undefined;
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        redirectUris: row.redirect_uris,
        admissionMode: row.admission_mode,
      }
    : null;
}

export type ActiveCloudOAuthAccessToken = {
  familyId: string;
  grantId: string;
  userId: string;
  tenantId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  cellId: string;
  cellDesiredState: "running" | "read_only" | "stopped" | "deleted";
};

/**
 * Looks up a Cloud-resource access token for the gateway (D3 step 4). Joins
 * only to the client-admission predicate above and to the principal's
 * non-deleted cell row — no candidate, assignment or reviewer-credential
 * joins, unlike `findMcpOAuthAccessToken`. `expectedResource` is compared
 * with plain equality against the token's stored resource: a hosted-resource
 * token never matches here, symmetrically to how a Cloud-resource token
 * never matches `EXOMEM_HOSTED_RESOURCE` in the hosted path.
 *
 * Returns the cell's `desired_state` rather than gating on it here — D3
 * gates on desired state as a distinct routing decision the gateway makes
 * after authentication succeeds (`running`/`read_only` proxy, anything else
 * is `CELL_NOT_READY`), not as part of "is this token valid".
 */
export async function findCloudOAuthAccessToken(
  accessDigest: Buffer,
  expectedResource: string
): Promise<ActiveCloudOAuthAccessToken | null> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:find-oauth-access-token */
    SELECT token.family_id, token.grant_id, oauth_grant.user_id, oauth_grant.tenant_id,
           client.client_id, token.resource, token.scopes,
           cell.cell_id, cell.desired_state AS cell_desired_state
    FROM exomem_oauth_access_tokens AS token
    JOIN exomem_oauth_token_families AS family
      ON family.id = token.family_id
     AND family.revoked_at IS NULL
     AND family.expires_at > now()
    JOIN exomem_oauth_grants AS oauth_grant
      ON oauth_grant.id = token.grant_id
     AND oauth_grant.revoked_at IS NULL
    JOIN exomem_oauth_clients AS client
      ON client.id = token.client_id
     AND client.enabled = true
     AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
     AND (
       client.admission_mode = 'pinned'
       OR (
         client.metadata_document_digest IS NOT NULL
         AND client.metadata_fetched_at IS NOT NULL
         AND client.metadata_ttl_seconds BETWEEN 300 AND 604800
         AND client.metadata_expires_at > now()
         AND client.cimd_host IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM exomem_oauth_admitted_cimd_hosts AS admitted
           WHERE admitted.host = client.cimd_host AND admitted.platform = client.client_platform
         )
       )
     )
    JOIN exomem_cloud_cells AS cell
      ON cell.tenant_id = oauth_grant.tenant_id
     AND cell.desired_state <> 'deleted'
    WHERE token.access_digest = ${accessDigest}
      AND token.revoked_at IS NULL
      AND token.expires_at > now()
      AND token.resource = ${expectedResource}
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = oauth_grant.tenant_id AND block.owner_user_id = oauth_grant.user_id
      )
    LIMIT 1
  `;
  const row = rows[0] as
    | {
        family_id: string;
        grant_id: string;
        user_id: string;
        tenant_id: string;
        client_id: string;
        resource: string;
        scopes: string[];
        cell_id: string;
        cell_desired_state: "running" | "read_only" | "stopped" | "deleted";
      }
    | undefined;
  return row
    ? {
        familyId: row.family_id,
        grantId: row.grant_id,
        userId: row.user_id,
        tenantId: row.tenant_id,
        clientId: row.client_id,
        resource: row.resource,
        scopes: row.scopes,
        cellId: row.cell_id,
        cellDesiredState: row.cell_desired_state,
      }
    : null;
}

export class CloudPrincipalHasNoCellError extends Error {
  constructor() {
    super("this principal owns no non-deleted Exomem Cloud cell row");
    this.name = "CloudPrincipalHasNoCellError";
  }
}

/**
 * D2: "A token for the Cloud resource SHALL be issued only to a principal
 * that owns a non-deleted cell row." Intended to be called by whichever
 * Cloud-aware authorization path grants an access token for the Cloud
 * resource, immediately before minting it — a principal is only ever given
 * a cell row by `redeemCloudInviteAtomic` (cloud-admission.ts), so this
 * rejects anyone who reached token issuance without having been admitted.
 */
export async function assertPrincipalOwnsCloudCell(tenantId: string): Promise<void> {
  const { rows } = await executeExomemSql`
    SELECT 1 FROM exomem_cloud_cells WHERE tenant_id = ${tenantId}::uuid AND desired_state <> 'deleted'
    LIMIT 1
  `;
  if (!rows[0]) throw new CloudPrincipalHasNoCellError();
}

/**
 * Security review finding 7: D2's "Cloud-resource tokens are issued, at code
 * exchange and at refresh, only when the principal owns a non-deleted cell
 * row" was not actually enforced there. `issueOAuthTokensFromCodeAtomic` and
 * `rotateOAuthRefreshTokenAtomic` (oauth-store.ts) are the hosted-shared
 * minting queries and know nothing about Cloud cells -- they gate only on
 * `exomem_tenants`/`exomem_entitlements`, which for a Cloud tenant is a
 * mirror of the cell's own desired_state (cloud-lifecycle.ts) and can still
 * read `active`/`running` for a tenant whose cell row was never created (or
 * was hard-deleted) at the moment a code or refresh token is presented.
 *
 * This is the Cloud-specific post-condition the token route applies to
 * their result before ever revealing the minted material to the caller,
 * keyed on the grant id the mint already returned rather than making the
 * route look up a tenant id separately.
 */
export async function assertGrantOwnsCloudCell(grantId: string): Promise<void> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:assert-grant-owns-cell */
    SELECT 1
    FROM exomem_oauth_grants AS oauth_grant
    JOIN exomem_cloud_cells AS cell
      ON cell.tenant_id = oauth_grant.tenant_id
     AND cell.desired_state <> 'deleted'
    WHERE oauth_grant.id = ${grantId}::uuid
    LIMIT 1
  `;
  if (!rows[0]) throw new CloudPrincipalHasNoCellError();
}
