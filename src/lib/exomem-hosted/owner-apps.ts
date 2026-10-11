/**
 * The apps an owner has connected to their Exomem, and disconnecting one.
 *
 * An app is a live OAuth grant for the Cloud resource. The list is what Home
 * shows, and the web journey polls it to learn when an app connected: an app
 * whose `lastAuthorizedAt` is later than the first poll's `serverTime` has
 * just joined.
 */

import { validate as validUuid } from "uuid";
import { loadExomemCloudResource } from "./cloud-config";
import { revokeOwnerOAuthGrant } from "./cloud-consent";
import { executeExomemSql } from "./db";
import { isSafeLoopbackOAuthRedirect } from "./oauth-client-admission";

export type OAuthClientDisplayNameSource = "client_metadata" | "platform" | "host";

export type OAuthClientIdentity = {
  clientId: string;
  /** The `client_name` the client declared in its registration or metadata document. */
  clientName: string | null;
  platform: string | null;
  cimdHost: string | null;
  redirectUris: string[];
};

export type OwnerApp = {
  id: string;
  displayName: string;
  displayNameSource: OAuthClientDisplayNameSource;
  platform: string | null;
  kind: "web" | "local";
  connectedAt: string;
  lastAuthorizedAt: string;
};

// Labels for `client_platform`, whose values are a closed set fixed by its
// CHECK constraint (migrations 0034 and 0048).
const PLATFORM_LABELS: Readonly<Record<string, string>> = { claude: "Claude", openai: "ChatGPT" };

/** The name to show for a client: its own declared name, else its platform, else its host. */
export function oauthClientDisplayName(client: OAuthClientIdentity): {
  displayName: string;
  displayNameSource: OAuthClientDisplayNameSource;
} {
  const declared = client.clientName?.trim();
  if (declared) return { displayName: declared, displayNameSource: "client_metadata" };
  if (client.platform && Object.hasOwn(PLATFORM_LABELS, client.platform)) {
    return { displayName: PLATFORM_LABELS[client.platform]!, displayNameSource: "platform" };
  }
  return { displayName: clientHost(client), displayNameSource: "host" };
}

// A CIMD client always has its metadata host. Any other client registered at
// least one redirect URI that parsed as a URL, so its first one names a host.
// The client id is the last resort only for a row that broke that invariant.
function clientHost(client: OAuthClientIdentity): string {
  if (client.cimdHost) return client.cimdHost;
  try {
    return new URL(client.redirectUris[0] ?? "").hostname || client.clientId;
  } catch {
    return client.clientId;
  }
}

// RFC 8252 section 7.3: a client whose every redirect is loopback receives its
// code on the owner's own machine, so it is a local app.
function clientKind(redirectUris: readonly string[]): OwnerApp["kind"] {
  return redirectUris.length > 0 && redirectUris.every(isSafeLoopbackOAuthRedirect)
    ? "local"
    : "web";
}

type ClientRow = {
  client_id: string;
  client_name: string | null;
  client_platform: string | null;
  cimd_host: string | null;
  redirect_uris: string[];
};

function identity(row: ClientRow): OAuthClientIdentity {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    platform: row.client_platform,
    cimdHost: row.cimd_host,
    redirectUris: row.redirect_uris,
  };
}

// `client_name` and `first_party` are read through `to_jsonb(client)`, which
// yields null for a column the table does not have yet. The generic-client
// migration adds `client_name` and the Home-client migration adds
// `first_party`; once both have shipped, read them as plain columns instead.

/** The client an authorization request names, for the consent page. */
export async function findOAuthClientIdentity(
  clientId: string
): Promise<OAuthClientIdentity | null> {
  const { rows } = await executeExomemSql`
    /* exomem:find-oauth-client-identity */
    SELECT client.client_id, to_jsonb(client) ->> 'client_name' AS client_name,
           client.client_platform, client.cimd_host, client.redirect_uris
    FROM exomem_oauth_clients AS client
    WHERE client.client_id = ${clientId}
  `;
  const row = rows[0] as ClientRow | undefined;
  return row ? identity(row) : null;
}

/**
 * The owner's connected apps, newest authorization first, and the database
 * clock the list was read at. First-party clients (Home's own) are not apps
 * the owner connected, so they are left out.
 */
export async function listOwnerApps(owner: {
  userId: string;
  tenantId: string;
}): Promise<{ serverTime: string; apps: OwnerApp[] }> {
  const resource = loadExomemCloudResource().mcpUrl;
  const { rows } = await executeExomemSql`
    /* exomem:list-owner-apps */
    SELECT clock.server_time, app.*
    FROM (SELECT now() AS server_time) AS clock
    LEFT JOIN LATERAL (
      SELECT oauth_grant.id, oauth_grant.created_at, oauth_grant.updated_at,
             client.client_id, to_jsonb(client) ->> 'client_name' AS client_name,
             client.client_platform, client.cimd_host, client.redirect_uris
      FROM exomem_oauth_grants AS oauth_grant
      JOIN exomem_tenants AS tenant
        ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
      JOIN exomem_oauth_clients AS client ON client.id = oauth_grant.client_id
      WHERE oauth_grant.user_id = ${owner.userId}::uuid
        AND oauth_grant.tenant_id = ${owner.tenantId}::uuid
        AND oauth_grant.resource = ${resource}
        AND oauth_grant.revoked_at IS NULL
        AND NOT COALESCE((to_jsonb(client) ->> 'first_party')::boolean, false)
    ) AS app ON true
    ORDER BY app.updated_at DESC NULLS LAST, app.id
  `;
  const serverTime = new Date(rows[0]!.server_time as string | Date).toISOString();
  const apps = (rows as Array<ClientRow & Record<string, unknown>>)
    .filter((row) => row.id !== null)
    .map((row): OwnerApp => {
      const client = identity(row);
      return {
        id: String(row.id),
        ...oauthClientDisplayName(client),
        platform: client.platform,
        kind: clientKind(client.redirectUris),
        connectedAt: new Date(row.created_at as string | Date).toISOString(),
        lastAuthorizedAt: new Date(row.updated_at as string | Date).toISOString(),
      };
    });
  return { serverTime, apps };
}

/** Disconnects one of the owner's apps. False when the id is not one of their grants. */
export async function disconnectOwnerApp(input: {
  userId: string;
  tenantId: string;
  appId: string;
}): Promise<boolean> {
  // A malformed id cannot name a grant; refusing it here keeps the uuid cast
  // in SQL from turning a typo into a server error.
  if (!validUuid(input.appId)) return false;
  return revokeOwnerOAuthGrant({
    userId: input.userId,
    tenantId: input.tenantId,
    grantId: input.appId,
  });
}
