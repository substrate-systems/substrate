/**
 * What Exomem knows about an OAuth client from its stored registration: the
 * name to show, the host its codes reach and the engagement context its calls
 * run in. The apps list, the consent page and the Cloud gateway all read
 * these, so each rule lives here once.
 */

import { clientPlatformName, type OAuthClientDisplayNameSource } from "./client-platforms";
import { isLoopbackRedirectDestination } from "./oauth-client-admission";
import type { OAuthClientContext } from "./oauth-client-context";

export type OAuthClientIdentity = {
  /** The stored `client_name`, or null when the client has none. */
  clientName: string | null;
  /** `admission_mode`, a closed set fixed by its CHECK constraint (migrations 0025 and 0062). */
  admissionMode: string;
  platform: string | null;
  /** The host of a CIMD client's `client_id` URL: the host that vouched for it; null otherwise. */
  cimdHost: string | null;
  /** The engagement context this lookup resolved: the grant's `client_context_override` when set, else the client row's registration-derived `client_context`. */
  clientContext: OAuthClientContext;
  redirectUris: string[];
};

/** The host an authorization code sent to `redirectUri` reaches. */
export function redirectHost(redirectUri: string): string {
  // Registration accepts only redirects that parse as URLs, so this cannot throw
  // for a stored client; a row that broke that invariant fails the read.
  return new URL(redirectUri).hostname;
}

/**
 * The name to show for a client: its stored name, else its platform's name,
 * else the host of `fallbackRedirectUri`.
 */
export function oauthClientDisplayName(
  client: Pick<OAuthClientIdentity, "clientName" | "admissionMode" | "platform">,
  fallbackRedirectUri: string
): { displayName: string; displayNameSource: OAuthClientDisplayNameSource } {
  const stored = client.clientName?.trim();
  if (stored) {
    // A pinned client exists only because the operator registered it, so its
    // name is the operator's. Every other client wrote its own name.
    const source = client.admissionMode === "pinned" ? "operator" : "client_metadata";
    return { displayName: stored, displayNameSource: source };
  }
  const platformName = clientPlatformName(client.platform);
  if (platformName) return { displayName: platformName, displayNameSource: "platform" };
  return { displayName: redirectHost(fallbackRedirectUri), displayNameSource: "redirect_host" };
}

/**
 * RFC 8252 section 7.3: a client whose every registered redirect is loopback
 * receives its codes on the owner's own machine, so it is a local app.
 */
export function isLocalOAuthClient(redirectUris: readonly string[]): boolean {
  return redirectUris.length > 0 && redirectUris.every(isLoopbackRedirectDestination);
}

/**
 * The context a client's calls run in: a local app is a coding agent, every
 * other client a conversational app. Registration stores the result in
 * `exomem_oauth_clients.client_context` as the default every grant starts
 * with; the gateway and the apps list read it under each grant's
 * `client_context_override`, so this derivation must not run at request time
 * again.
 */
export function oauthClientContext(redirectUris: readonly string[]): OAuthClientContext {
  return isLocalOAuthClient(redirectUris) ? "coding" : "conversation";
}
