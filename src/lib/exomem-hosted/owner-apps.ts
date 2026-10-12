/**
 * The apps an owner has connected to their Exomem, and disconnecting one.
 *
 * An app is a grant for the Cloud resource from a client that is not Exomem's
 * own. The list is what Home shows, and the web journey polls it to learn when
 * an app connected: an app whose `lastAuthorizedAt` is later than the first
 * poll's `serverTime` has just joined.
 */

import { validate as validUuid } from "uuid";
import type { OAuthClientDisplayNameSource } from "./client-platforms";
import { loadExomemCloudResource } from "./cloud-config";
import { revokeOwnerOAuthGrant } from "./cloud-consent";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import {
  isLocalOAuthClient,
  oauthClientContext,
  oauthClientDisplayName,
  redirectHost,
  type OAuthClientContext,
  type OAuthClientIdentity,
} from "./oauth-client-identity";

export { oauthClientDisplayName, redirectHost, type OAuthClientIdentity };

export type OwnerApp = {
  id: string;
  displayName: string;
  displayNameSource: OAuthClientDisplayNameSource;
  platform: string | null;
  kind: "web" | "local";
  /** The context the app's calls run in; the journey saves a chosen level to it. */
  context: OAuthClientContext;
  /** Every distinct host the app's registered redirects name, loopback included. */
  redirectHosts: string[];
  connectedAt: string;
  lastAuthorizedAt: string;
};

function clientKind(redirectUris: readonly string[]): OwnerApp["kind"] {
  return isLocalOAuthClient(redirectUris) ? "local" : "web";
}

/** The client an authorization request names, for the consent page. */
export async function findOAuthClientIdentity(
  clientId: string
): Promise<OAuthClientIdentity | null> {
  const { rows } = await executeExomemSql`
    /* exomem:find-oauth-client-identity */
    SELECT client.client_name, client.admission_mode, client.client_platform, client.redirect_uris
    FROM exomem_oauth_clients AS client
    WHERE client.client_id = ${clientId}
  `;
  const row = rows[0] as AppRow | undefined;
  return row
    ? {
        clientName: row.client_name,
        admissionMode: row.admission_mode,
        platform: row.client_platform,
        redirectUris: row.redirect_uris,
      }
    : null;
}

type AppRow = {
  id: string;
  created_at: string | Date;
  updated_at: string | Date;
  client_name: string | null;
  admission_mode: string;
  client_platform: string | null;
  redirect_uris: string[];
};

/**
 * The one rule for which grants are an owner's apps: theirs, for the Cloud
 * resource, from a client that is not first-party. The list shows the live
 * ones; disconnect answers 404 for any id outside this rule.
 */
async function ownerAppRows(
  sql: ExomemSql,
  input: { userId: string; tenantId: string; grantId: string | null }
): Promise<AppRow[]> {
  const resource = loadExomemCloudResource().mcpUrl;
  const { rows } = await sql`
    /* exomem:owner-app-grants */
    SELECT oauth_grant.id, oauth_grant.created_at, oauth_grant.updated_at,
           client.client_name, client.admission_mode, client.client_platform, client.redirect_uris
    FROM exomem_oauth_grants AS oauth_grant
    JOIN exomem_tenants AS tenant
      ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
    JOIN exomem_oauth_clients AS client ON client.id = oauth_grant.client_id
    WHERE oauth_grant.user_id = ${input.userId}::uuid
      AND oauth_grant.tenant_id = ${input.tenantId}::uuid
      AND oauth_grant.resource = ${resource}
      AND client.admission_mode <> 'first_party'
      AND (${input.grantId}::uuid IS NULL OR oauth_grant.id = ${input.grantId}::uuid)
      -- The list reads live grants only, which lets it use the partial index on
      -- live grants. Disconnect by id also sees a revoked grant, so a repeat
      -- disconnect still answers 200.
      AND (${input.grantId}::uuid IS NOT NULL OR oauth_grant.revoked_at IS NULL)
    ORDER BY oauth_grant.updated_at DESC, oauth_grant.id
  `;
  return rows as AppRow[];
}

/**
 * The owner's connected apps, newest authorization first, and the database
 * time read just before the list. A grant stamped after `serverTime` is newer
 * than this read.
 */
export async function listOwnerApps(owner: {
  userId: string;
  tenantId: string;
}): Promise<{ serverTime: string; apps: OwnerApp[] }> {
  const clock = await executeExomemSql`SELECT now() AS server_time`;
  const serverTime = new Date(clock.rows[0]!.server_time as string | Date).toISOString();
  const rows = await ownerAppRows(executeExomemSql, { ...owner, grantId: null });
  const apps = rows.map(
    (row): OwnerApp => ({
      id: String(row.id),
      ...oauthClientDisplayName(
        {
          clientName: row.client_name,
          admissionMode: row.admission_mode,
          platform: row.client_platform,
        },
        row.redirect_uris[0]!
      ),
      platform: row.client_platform,
      kind: clientKind(row.redirect_uris),
      context: oauthClientContext(row.redirect_uris),
      redirectHosts: [...new Set(row.redirect_uris.map(redirectHost))],
      connectedAt: new Date(row.created_at).toISOString(),
      lastAuthorizedAt: new Date(row.updated_at).toISOString(),
    })
  );
  return { serverTime, apps };
}

/**
 * Disconnects one of the owner's apps. False when the id is not one the list
 * could show; true for an app disconnected now or earlier.
 */
export async function disconnectOwnerApp(input: {
  userId: string;
  tenantId: string;
  appId: string;
}): Promise<boolean> {
  // A malformed id cannot name a grant; refusing it here keeps the uuid cast
  // in SQL from turning a typo into a server error.
  if (!validUuid(input.appId)) return false;
  return withExomemTransaction(async (tx) => {
    // Code exchange and refresh rotation lock the tenant first, so a disconnect
    // waits for one in flight and the next one sees the revoked grant.
    const tenant = await tx`
      /* exomem:lock-owner-tenant-for-disconnect */
      SELECT tenant.id FROM exomem_tenants AS tenant
      WHERE tenant.id = ${input.tenantId}::uuid AND tenant.owner_user_id = ${input.userId}::uuid
      FOR UPDATE
    `;
    if (!tenant.rows[0]) return false;
    const [app] = await ownerAppRows(tx, {
      userId: input.userId,
      tenantId: input.tenantId,
      grantId: input.appId,
    });
    if (!app) return false;
    await revokeOwnerOAuthGrant(tx, {
      userId: input.userId,
      tenantId: input.tenantId,
      grantId: app.id,
    });
    return true;
  });
}
