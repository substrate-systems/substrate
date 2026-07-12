type VercelAnalyticsEvent = {
  url: string;
};

type PostHogCapture = {
  properties?: Record<string, unknown>;
};

const PRIVATE_EXOMEM_PATHS = [
  "/exomem/invite",
  "/exomem/sign-in",
  "/exomem/home",
  "/exomem/account",
  "/exomem/billing",
  "/exomem/export",
  "/exomem/restore",
  "/exomem/delete",
] as const;

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
