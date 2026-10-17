/**
 * How Exomem names an OAuth client. Safe for browser bundles: no server imports.
 */

/**
 * The product name for each client platform. `client_platform` is a closed set
 * fixed by its CHECK constraint (migrations 0034 and 0048), so a name per value
 * is code, not data.
 */
export const CLIENT_PLATFORM_NAMES = { claude: "Claude", openai: "ChatGPT" } as const;

// The approved letter glyphs map to the schema's closed client_platform set.
export const CLIENT_PLATFORM_GLYPHS = { claude: "C", openai: "G" } as const;

// The cell protocol fixes these content-free activity families.
export const CLIENT_FAMILY_NAMES = {
  "claude-ai": CLIENT_PLATFORM_NAMES.claude,
  chatgpt: CLIENT_PLATFORM_NAMES.openai,
  "claude-code": "Claude Code",
  codex: "Codex",
  other: "Your app",
} as const;
export const CLIENT_FAMILY_GLYPHS = {
  "claude-ai": "C",
  chatgpt: "G",
  "claude-code": ">_",
  codex: ">_",
  other: "+",
} as const;

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
 * Whether the name is the client's own claim, which whoever runs it can
 * choose, so the consent page and Home label it and show where its codes go.
 * A name Exomem vouches for (operator, platform) and a redirect-host fallback
 * are no claim, so they get no label.
 */
export function displayNameClaimedByApp(source: OAuthClientDisplayNameSource): boolean {
  return source === "client_metadata";
}
