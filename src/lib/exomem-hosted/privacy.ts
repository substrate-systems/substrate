type VercelAnalyticsEvent = {
  url: string;
};

type PostHogCapture = {
  properties?: Record<string, unknown>;
};

/**
 * Authenticated Exomem surfaces. Analytics must not mount, and no capture may
 * escape, on any of these.
 *
 * Every route rendering `PrivateShell` belongs here. `/exomem/adopt` was added
 * when the Adoption Studio shipped but not listed, so pageviews carrying
 * `$current_url` escaped from an authenticated surface until this was corrected;
 * `private-shell-coverage.test.ts` now pins the two lists together so a new
 * private route cannot be added without also being excluded here.
 *
 * `/exomem/account`, `/exomem/billing`, `/exomem/export` and `/exomem/restore`
 * are deliberately listed ahead of the routes existing — excluding a path that
 * never ships costs nothing, while shipping one that is not excluded leaks.
 */
const PRIVATE_EXOMEM_PATHS = [
  "/exomem/invite",
  "/exomem/sign-in",
  "/exomem/home",
  "/exomem/adopt",
  "/exomem/account",
  "/exomem/billing",
  "/exomem/export",
  "/exomem/restore",
  "/exomem/delete",
] as const;

/** Exposed so the coverage test can compare against the routes on disk. */
export const privateExomemPaths: readonly string[] = PRIVATE_EXOMEM_PATHS;

function pathname(value: string): string | null {
  try {
    return new URL(value, "https://privacy.invalid").pathname;
  } catch {
    return null;
  }
}

export function isPrivateExomemPath(value: string): boolean {
  const path = pathname(value);
  if (!path) return false;
  return PRIVATE_EXOMEM_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function shouldMountAnalytics(value: string | null): boolean {
  return value !== null && !isPrivateExomemPath(value);
}

export function shouldReloadAnalyticsDocument(
  analyticsMounted: boolean,
  value: string | null
): boolean {
  return analyticsMounted && value !== null && isPrivateExomemPath(value);
}

export function filterVercelAnalyticsEvent<T extends VercelAnalyticsEvent>(event: T): T | null {
  return isPrivateExomemPath(event.url) ? null : event;
}

export function filterPostHogCapture<T extends PostHogCapture>(
  capture: T | null,
  currentUrl: string
): T | null {
  if (!capture || isPrivateExomemPath(currentUrl)) return null;
  const eventUrl = capture.properties?.$current_url;
  return typeof eventUrl === "string" && isPrivateExomemPath(eventUrl) ? null : capture;
}
