import type { ExomemCloudResource } from "./cloud-config";
import { ADVERTISED_SCOPES } from "./oauth";
import type { OAuthClientIdentity } from "./oauth-client-identity";
/**
 * Exomem Cloud OAuth client admission and exact-resource token binding
 * (design D2, `adopt-exomem-cloud-plain-cells`).
 *
 * Cloud admission is the D2 predicate, exactly:
 *
 *   "For the Cloud MCP resource, an OAuth client SHALL be admitted when it
 *    is enabled, its redirect URI matches its registered digest, and its
 *    CIMD metadata host is approved and fresh. Admission MUST NOT require a
 *    live cohort or a reviewer credential."
 *
 * A token is bound to exactly one resource, and is accepted only where its
 * resource is exactly equal to the resource being served:
 * `exomem_oauth_access_tokens.resource` is a plain text column and every
 * lookup here filters on it exactly.
 */

import { executeExomemSql } from "./db";
import { cloudReviewerAccessEnabled } from "./cloud-reviewer-access-store";

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
  admissionMode: "pinned" | "cimd" | "generic";
};

/**
 * Cloud client admission (D2): enabled, redirect digest match, and — for a
 * self-registering CIMD client — a fresh metadata document served from a
 * host on the operator-curated allowlist. A generic MCP client is admitted
 * while the generic lane is enabled (`exomem_oauth_generic_client_admitted`,
 * admit-generic-mcp-clients). No whole-cohort check, no reviewer-credential
 * branch: Cloud has no cohort or candidate concept.
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
      -- The first_party mode is absent: that client gets tokens only from
      -- the server-side mint (cloud-home-mcp.ts), never through a consent.
      AND admission_mode IN ('pinned', 'cimd', 'generic')
      AND enabled = true
      AND (
        admission_mode = 'pinned'
        OR exomem_oauth_generic_client_admitted(client.admission_mode)
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
    | {
        id: string;
        client_id: string;
        redirect_uris: string[];
        admission_mode: ApprovedCloudOAuthClient["admissionMode"];
      }
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

/** A login family's current authority: what both an access token and a delegated upload resolve to. */
export type ActiveCloudOAuthLogin = {
  familyId: string;
  grantId: string;
  userId: string;
  tenantId: string;
  clientId: string;
  resource: string;
  cellId: string;
  cellDesiredState: "running" | "read_only" | "stopped" | "deleted";
  /** The token's client as stored, from which the gateway names it to the cell. */
  client: OAuthClientIdentity;
  /** The token belongs to the first-party Home client, by its stored admission mode. */
  firstParty: boolean;
};

export type ActiveCloudOAuthAccessToken = ActiveCloudOAuthLogin & { scopes: string[] };

type CloudOAuthSelector = { accessDigest: Buffer } | { familyId: string; grantId: string };

/**
 * Looks up a Cloud-resource access token for the gateway (D3 step 4). Joins
 * to the client-admission predicate above and to the principal's non-deleted
 * cell row. Reviewer lineages additionally require matching Cloud credential
 * authority; ordinary NULL lineages retain their existing routing semantics.
 * There is no candidate or assignment authority. `expectedResource` is compared
 * with plain equality against the token's stored resource, so a token minted
 * for the retired Hosted resource never matches here.
 *
 * Returns the cell's `desired_state` rather than gating on it here — D3
 * gates on desired state as a distinct routing decision the gateway makes
 * after authentication succeeds (`running`/`read_only` proxy, anything else
 * is `CELL_NOT_READY`), not as part of "is this token valid".
 *
 * L3: also requires the tenant's own `status` to be outside
 * `deletion_pending`/`deleted`. A confirmed deletion revokes the tenant's
 * OAuth grants only once the Cloud reconcile has deleted its cell row (D4);
 * until then -- or if that reconcile ever fails -- the cell row can still be
 * non-deleted while the account is gone, and this token must not work.
 */
export async function findCloudOAuthAccessToken(
  accessDigest: Buffer,
  expectedResource: string
): Promise<ActiveCloudOAuthAccessToken | null> {
  const row = await findCloudOAuthAuthority({ accessDigest }, expectedResource);
  return row ? { ...cloudOAuthLogin(row), scopes: row.scopes! } : null;
}

/**
 * Looks up a login family's current authority for a delegated upload
 * (bridge-cloud-agent-uploads). The upload carries no bearer, and the family
 * outlives each short access token, so this applies every predicate of the
 * token lookup above except the token row's own.
 */
export async function findCloudOAuthLogin(
  login: { familyId: string; grantId: string },
  expectedResource: string
): Promise<ActiveCloudOAuthLogin | null> {
  const row = await findCloudOAuthAuthority(login, expectedResource);
  return row ? cloudOAuthLogin(row) : null;
}

type CloudOAuthAuthorityRow = {
  family_id: string;
  grant_id: string;
  user_id: string;
  tenant_id: string;
  client_id: string;
  resource: string;
  scopes: string[] | null;
  cell_id: string;
  cell_desired_state: "running" | "read_only" | "stopped" | "deleted";
  client_name: string | null;
  admission_mode: string;
  client_platform: string | null;
  redirect_uris: string[];
};

/**
 * One statement for both selectors, so the admission and revocation policy has
 * one copy. Every query here is unnamed and planned with its values, so the
 * unused branch of `token` folds away and the access-digest index still drives
 * an MCP request.
 */
async function findCloudOAuthAuthority(
  selector: CloudOAuthSelector,
  expectedResource: string
): Promise<CloudOAuthAuthorityRow | null> {
  const accessDigest = "accessDigest" in selector ? selector.accessDigest : null;
  const familyId = "familyId" in selector ? selector.familyId : null;
  const grantId = "grantId" in selector ? selector.grantId : null;
  const { rows } = await executeExomemSql`
    /* exomem-cloud:find-oauth-access-token */
    WITH token AS (
      SELECT access.family_id, access.grant_id, access.client_id, access.resource, access.scopes,
             access.reviewer_credential_id, access.candidate_id
      FROM exomem_oauth_access_tokens AS access
      WHERE ${accessDigest}::bytea IS NOT NULL
        AND access.access_digest = ${accessDigest}::bytea
        AND access.revoked_at IS NULL
        AND access.expires_at > now()
      UNION ALL
      -- A delegated upload names its login family; the family row stands in
      -- for the token, and its lineage is checked against the grant below.
      SELECT login.id, login.grant_id, login.client_id, ${expectedResource}::text, NULL::text[],
             login.reviewer_credential_id, login.candidate_id
      FROM exomem_oauth_token_families AS login
      WHERE ${accessDigest}::bytea IS NULL
        AND login.id = ${familyId}::uuid AND login.grant_id = ${grantId}::uuid
    )
    SELECT token.family_id, token.grant_id, oauth_grant.user_id, oauth_grant.tenant_id,
           client.client_id, token.resource, token.scopes,
           cell.cell_id, cell.desired_state AS cell_desired_state,
           client.client_name, client.admission_mode, client.client_platform, client.redirect_uris
    FROM token
    JOIN exomem_oauth_token_families AS family
      ON family.id = token.family_id
     AND family.grant_id = token.grant_id AND family.client_id = token.client_id
     AND family.revoked_at IS NULL
     AND family.expires_at > now()
    JOIN exomem_oauth_grants AS oauth_grant
      ON oauth_grant.id = token.grant_id
     AND oauth_grant.client_id = token.client_id AND oauth_grant.resource = token.resource
     AND oauth_grant.revoked_at IS NULL
    JOIN exomem_oauth_clients AS client
      ON client.id = token.client_id
     AND client.enabled = true
     AND client.redirect_uris_digest = digest(convert_to(client.redirect_uris::text, 'utf8'), 'sha256')
     AND (
       client.admission_mode = 'pinned'
       -- Only the server-side mint writes a first-party token; this lookup
       -- is the one place that admits the mode.
       OR client.admission_mode = 'first_party'
       OR exomem_oauth_generic_client_admitted(client.admission_mode)
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
    JOIN exomem_tenants AS tenant
      ON tenant.id = oauth_grant.tenant_id
     AND tenant.status NOT IN ('deletion_pending', 'deleted')
    WHERE token.resource = ${expectedResource}
      AND token.reviewer_credential_id IS NOT DISTINCT FROM family.reviewer_credential_id
      AND token.reviewer_credential_id IS NOT DISTINCT FROM oauth_grant.reviewer_credential_id
      AND token.candidate_id IS NULL AND family.candidate_id IS NULL AND oauth_grant.candidate_id IS NULL
      AND (token.reviewer_credential_id IS NULL OR (
        ${cloudReviewerAccessEnabled()}
        AND exomem_cloud_reviewer_authorized(token.reviewer_credential_id, oauth_grant.tenant_id, oauth_grant.user_id, client.client_platform)
      ))
      AND NOT EXISTS (
        SELECT 1 FROM exomem_oauth_account_blocks AS block
        WHERE block.tenant_id = oauth_grant.tenant_id AND block.owner_user_id = oauth_grant.user_id
      )
    LIMIT 1
  `;
  return (rows[0] as CloudOAuthAuthorityRow | undefined) ?? null;
}

function cloudOAuthLogin(row: CloudOAuthAuthorityRow): ActiveCloudOAuthLogin {
  return {
    familyId: row.family_id,
    grantId: row.grant_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    resource: row.resource,
    cellId: row.cell_id,
    cellDesiredState: row.cell_desired_state,
    client: {
      clientName: row.client_name,
      admissionMode: row.admission_mode,
      platform: row.client_platform,
      redirectUris: row.redirect_uris,
    },
    firstParty: row.admission_mode === "first_party",
  };
}

/** Home shows the day an app was last used, so its time moves at most once in this window. */
export const APP_USE_WINDOW_SECONDS = 300;

/** Records that an app reached its Exomem, for Home's "used today". */
export async function recordCloudAppUse(grantId: string): Promise<void> {
  await executeExomemSql`
    /* exomem-cloud:record-app-use */
    INSERT INTO exomem_oauth_grant_usage AS app_use (grant_id, last_used_at)
    VALUES (${grantId}::uuid, now())
    ON CONFLICT (grant_id) DO UPDATE SET last_used_at = excluded.last_used_at
    WHERE app_use.last_used_at
      < excluded.last_used_at - make_interval(secs => ${APP_USE_WINDOW_SECONDS})
  `;
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

/**
 * RFC 9728 section 5.1: a 401 names the resource's own metadata document
 * (`<origin>/.well-known/oauth-protected-resource<mcpPath>`, where server.ts
 * serves it) and the scopes to request, so a client reaches the
 * authorization server without probing well-known paths.
 */
export function cloudBearerChallenge(config: ExomemCloudResource): string {
  const metadata = `${new URL(config.mcpUrl).origin}/.well-known/oauth-protected-resource${config.mcpPath}`;
  return `Bearer resource_metadata="${metadata}", scope="${ADVERTISED_SCOPES.join(" ")}"`;
}
