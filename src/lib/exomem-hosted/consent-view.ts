/**
 * Everything the consent page shows, decided on the server for one OAuth
 * authorization request and the browser's session. The page renders these
 * props and computes no state of its own.
 */

import { loadOwnerBillingAccount } from "./billing-account";
import type { EnvironmentSource } from "./cloud-config";
import { loadExomemCloudResource } from "./cloud-config";
import { getOwnerCloudStatus } from "./cloud-status";
import { consentStep, type ConsentStep } from "./consent-state";
import { executeExomemSql, findExomemSessionByDigest } from "./db";
import { known, unknown, type Known } from "./known";
import { isSafeLoopbackOAuthRedirect } from "./oauth-client-admission";
import {
  matchesOAuthConfirmationHandle,
  oauthFormNonceFromCookie,
  resolveOAuthContinuationToken,
  type OAuthContinuation,
} from "./oauth-continuity";
import {
  findOAuthClientIdentity,
  oauthClientDisplayName,
  redirectHost,
  type OAuthClientDisplayNameSource,
} from "./owner-apps";
import { marketplaceReviewerAccessEnabled } from "./reviewer-access";
import { tokenDigest } from "./security";

export type ConsentView =
  // No live request to show: start again from the app.
  | { step: "expired" }
  | {
      step: ConsentStep;
      app: {
        displayName: string;
        /** Only `platform` is vouched for; a `client_metadata` name is the app's own claim. */
        displayNameSource: OAuthClientDisplayNameSource;
        platform: string | null;
        /** The request's redirect is loopback: the code goes to this computer. */
        loopback: boolean;
        /** The host this request's authorization code would be sent to. */
        redirectHost: string;
      };
      scopes: string[];
      signedInEmail: string | null;
      /** A live grant already exists for this user, tenant, app and resource. */
      alreadyConnected: boolean;
      cellStarting: boolean;
      readOnlyUntil: Known<string, typeof NOT_COMPUTED>;
      keptUntil: Known<string, typeof NOT_COMPUTED>;
      supportReference: Known<string, typeof NOT_COMPUTED>;
      connectorSettingsUrl: Known<string, ConnectorSettingsReason>;
      /** What the page's forms send back to complete or decline this request. */
      confirmation: string;
      nonce: string;
      reviewerEnabled: boolean;
    };

export type ConsentViewInput = {
  confirmation: string | undefined;
  transactionCookie: string | undefined;
  formNonceCookie: string | undefined;
  sessionCookie: string | undefined;
};

// Neither date nor the support reference is stored yet. They come from the
// account view (launch-exomem-cloud-web, account contract), and until then the
// page shows them as unknown rather than inventing a value.
const NOT_COMPUTED = "not_computed";

export type ConnectorSettingsReason =
  | "local_app"
  | "platform_unknown"
  | "not_configured"
  | "invalid_configuration";

type Visitor = {
  effectiveState: string;
  sourceState: string;
  cellStarting: boolean;
  email: string;
  alreadyConnected: boolean;
};

export async function loadConsentView(
  input: ConsentViewInput,
  env: EnvironmentSource = process.env
): Promise<ConsentView> {
  const nonce = oauthFormNonceFromCookie(input.formNonceCookie);
  const continuation = matchesOAuthConfirmationHandle(input.transactionCookie, input.confirmation)
    ? await resolveOAuthContinuationToken(input.transactionCookie)
    : null;
  if (!continuation || !nonce || !input.confirmation) return { step: "expired" };
  const [client, visitor] = await Promise.all([
    findOAuthClientIdentity(continuation.clientId),
    visitorFor(input.sessionCookie, continuation),
  ]);
  // The request was resolved against this client a moment ago; a client row
  // gone since then leaves nothing to name, so the request is over.
  if (!client) return { step: "expired" };
  const loopback = isSafeLoopbackOAuthRedirect(continuation.redirectUri);
  return {
    step: consentStep(visitor),
    // The fallback name is the host this request's code goes to, not any other
    // redirect the client registered.
    app: {
      ...oauthClientDisplayName(client, continuation.redirectUri),
      platform: client.platform,
      loopback,
      redirectHost: redirectHost(continuation.redirectUri),
    },
    scopes: continuation.scopes,
    signedInEmail: visitor?.email ?? null,
    alreadyConnected: visitor?.alreadyConnected ?? false,
    cellStarting: visitor?.cellStarting ?? false,
    readOnlyUntil: unknown(NOT_COMPUTED),
    keptUntil: unknown(NOT_COMPUTED),
    supportReference: unknown(NOT_COMPUTED),
    connectorSettingsUrl: connectorSettingsUrl(client.platform, loopback, env),
    confirmation: input.confirmation,
    nonce,
    reviewerEnabled:
      marketplaceReviewerAccessEnabled() &&
      continuation.resource === loadExomemCloudResource(env).mcpUrl,
  };
}

// Whether the visitor has an Exomem, and in what state, decides what this page
// offers. Without it, "Continue" was rendered to everyone -- including someone
// arriving from a connector before they have ever redeemed their invitation, or
// before their first payment, for whom it can only ever end in a refusal.
async function visitorFor(
  sessionToken: string | undefined,
  continuation: OAuthContinuation
): Promise<Visitor | null> {
  if (!sessionToken) return null;
  const digest = tokenDigest(sessionToken);
  if (!digest) return null;
  try {
    const session = await findExomemSessionByDigest(digest);
    // A reviewer cookie from another connection is not consent authority for
    // this one. Offer fresh reviewer sign-in until its credential is bound.
    if (
      !session ||
      (session.reviewerCredentialId ?? null) !== (continuation.reviewerCredentialId ?? null)
    ) {
      return null;
    }
    const account = await loadOwnerBillingAccount(session.userId, session.tenantId);
    if (!account) return null;
    const [status, owner] = await Promise.all([
      getOwnerCloudStatus(session.tenantId),
      ownerFacts(session, continuation),
    ]);
    if (!owner) return null;
    return {
      effectiveState: account.effectiveState,
      sourceState: account.sourceState,
      cellStarting: status.state !== "ready",
      ...owner,
    };
  } catch {
    // Never let a storage failure decide the layout. Presenting the sign-in
    // paths to someone who is in fact signed in costs them one extra click;
    // presenting Continue to someone who is not is a dead end.
    return null;
  }
}

// `alreadyConnected` is the grant table's own uniqueness key (user, tenant,
// client, resource) among live grants: exactly the grant a Connect would
// update rather than create.
async function ownerFacts(
  session: { userId: string; tenantId: string },
  continuation: OAuthContinuation
): Promise<{ email: string; alreadyConnected: boolean } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:consent-view-owner */
    SELECT users.email::text AS email,
           EXISTS (
             SELECT 1
             FROM exomem_oauth_grants AS oauth_grant
             JOIN exomem_oauth_clients AS client ON client.id = oauth_grant.client_id
             WHERE oauth_grant.user_id = users.id
               AND oauth_grant.tenant_id = ${session.tenantId}::uuid
               AND client.client_id = ${continuation.clientId}
               AND oauth_grant.resource = ${continuation.resource}
               AND oauth_grant.revoked_at IS NULL
           ) AS already_connected
    FROM users
    WHERE users.id = ${session.userId}::uuid
  `;
  const row = rows[0] as { email: string; already_connected: boolean } | undefined;
  return row ? { email: row.email, alreadyConnected: row.already_connected } : null;
}

/**
 * Where the app's own connector settings live, for "Connect after all". Vendors
 * move these pages, so the addresses are configuration:
 * `EXOMEM_CONNECTOR_SETTINGS_URLS`, a JSON object from client platform to an
 * https URL. A local app has no such page.
 */
export function connectorSettingsUrl(
  platform: string | null,
  loopback: boolean,
  env: EnvironmentSource = process.env
): Known<string, ConnectorSettingsReason> {
  if (loopback) return unknown("local_app");
  if (!platform) return unknown("platform_unknown");
  const raw = env.EXOMEM_CONNECTOR_SETTINGS_URLS?.trim();
  if (!raw) return unknown("not_configured");
  let urls: unknown;
  try {
    urls = JSON.parse(raw);
  } catch {
    return invalidConnectorSettings();
  }
  if (!urls || typeof urls !== "object" || Array.isArray(urls)) return invalidConnectorSettings();
  if (!Object.hasOwn(urls, platform)) return unknown("not_configured");
  const value = (urls as Record<string, unknown>)[platform];
  // The page renders this as a link, so nothing but an https address is used.
  if (typeof value !== "string" || !isHttpsUrl(value)) return invalidConnectorSettings();
  return known(value);
}

function invalidConnectorSettings(): Known<string, ConnectorSettingsReason> {
  console.warn({ event: "exomem_connector_settings_invalid" });
  return unknown("invalid_configuration");
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
