/**
 * How Exomem names an OAuth client. Safe for browser bundles: no server imports.
 */

/**
 * The product name for each client platform. `client_platform` is a closed set
 * fixed by its CHECK constraint (migrations 0034 and 0048), so a name per value
 * is code, not data.
 */
export const CLIENT_PLATFORM_NAMES = { claude: "Claude", openai: "ChatGPT" } as const;

export type ClientPlatform = keyof typeof CLIENT_PLATFORM_NAMES;

export function clientPlatformName(platform: string | null): string | null {
  return platform !== null && Object.hasOwn(CLIENT_PLATFORM_NAMES, platform)
    ? CLIENT_PLATFORM_NAMES[platform as ClientPlatform]
    : null;
}

/**
 * Where a display name came from:
 * - `operator`: the operator registered the client and named it;
 * - `platform`: the product name of the client's platform;
 * - `client_metadata`: the name the client gives itself, which anyone can choose;
 * - `redirect_host`: the host the client's authorization codes are sent to.
 */
export type OAuthClientDisplayNameSource =
  | "operator"
  | "platform"
  | "client_metadata"
  | "redirect_host";

/**
 * Whether Exomem vouches for the name. Any other name could be chosen by
 * whoever runs the client, so a page shows where its codes go beside it.
 */
export function displayNameVouched(source: OAuthClientDisplayNameSource): boolean {
  return source === "operator" || source === "platform";
}
