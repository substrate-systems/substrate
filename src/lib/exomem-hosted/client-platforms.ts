/**
 * The product name for each OAuth client platform. `client_platform` is a
 * closed set fixed by its CHECK constraint (migrations 0034 and 0048), so a
 * name per value is code, not data. Safe for browser bundles: no server imports.
 */
export const CLIENT_PLATFORM_NAMES = { claude: "Claude", openai: "ChatGPT" } as const;

export type ClientPlatform = keyof typeof CLIENT_PLATFORM_NAMES;

export function clientPlatformName(platform: string | null): string | null {
  return platform !== null && Object.hasOwn(CLIENT_PLATFORM_NAMES, platform)
    ? CLIENT_PLATFORM_NAMES[platform as ClientPlatform]
    : null;
}
