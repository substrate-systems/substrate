/**
 * The engagement contexts a cell resolves levels for: the closed set
 * `exomem_oauth_clients.client_context` and `exomem_oauth_grants
 * .client_context_override` are CHECKed on (migration 0088). This module is
 * dependency-free on purpose: the Home app's client components import it, so
 * nothing here may pull a server-only import (dns, pg) into the browser
 * bundle.
 */
export const OAUTH_CLIENT_CONTEXTS = ["coding", "conversation"] as const;

export type OAuthClientContext = (typeof OAUTH_CLIENT_CONTEXTS)[number];
