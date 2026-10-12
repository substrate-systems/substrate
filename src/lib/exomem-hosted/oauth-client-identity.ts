/**
 * What Exomem knows about an OAuth client from its stored registration: the
 * name to show, the host its codes reach and the engagement context its calls
 * run in. The apps list, the consent page and the Cloud gateway all read
 * these, so each rule lives here once.
 */

import { clientPlatformName, type OAuthClientDisplayNameSource } from "./client-platforms";
import { isSafeLoopbackOAuthRedirect } from "./oauth-client-admission";

export type OAuthClientIdentity = {
  /** The stored `client_name`, or null when the client has none. */
  clientName: string | null;
  /** `admission_mode`, a closed set fixed by its CHECK constraint (migrations 0025 and 0062). */
  admissionMode: string;
  platform: string | null;
  redirectUris: string[];
};

/** The engagement contexts a cell resolves levels for; the cell's own closed set. */
export type OAuthClientContext = "coding" | "conversation";

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
  return redirectUris.length > 0 && redirectUris.every(isSafeLoopbackOAuthRedirect);
}

/**
 * The context a client's calls run in: a local app is a coding agent, every
 * other client a conversational app. It reads the client's registered
 * redirects, which last as long as the client; a grant keeps no redirect,
 * because its authorization transaction is pruned a day after use.
 */
export function oauthClientContext(redirectUris: readonly string[]): OAuthClientContext {
  return isLocalOAuthClient(redirectUris) ? "coding" : "conversation";
}
