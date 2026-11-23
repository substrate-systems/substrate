/**
 * Where Exomem's status page lives: `EXOMEM_STATUS_PAGE_URL`, an https address.
 * Configuration, because the page is a third party's and its address can change.
 * This is the one place that names the setting and its default. It imports nothing,
 * so Next pages, the email outbox and the gateway bundle can all use it.
 */

const DEFAULT_STATUS_PAGE_URL = "https://status.substratesystems.io";

/**
 * The configured address, for "Status page" links that appear only when someone set
 * one. Unset or invalid: no link, and the page does not mention one.
 */
export function statusPageUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  const value = env.EXOMEM_STATUS_PAGE_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** The address for service notices, which always point at a status page: the default when none is set. */
export function statusPageUrlOrDefault(
  env: Record<string, string | undefined> = process.env
): string {
  return statusPageUrl(env) ?? DEFAULT_STATUS_PAGE_URL;
}
