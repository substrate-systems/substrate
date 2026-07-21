import posthog from "posthog-js";

/**
 * Client-side product analytics.
 *
 * Event names are centralised here so the taxonomy stays greppable and a typo
 * cannot silently create a parallel event that never shows up in a funnel.
 * Every capture no-ops when PostHog was never initialised (no key configured),
 * so callers do not need to guard.
 */
export const AnalyticsEvent = {
  /** Intent to install: a click on any link resolving to /download. */
  DownloadClicked: "download_clicked",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/**
 * Set by PostHogProvider once init has run. Tracked here rather than reading
 * posthog.__loaded so we depend on our own initialisation, not an SDK internal.
 */
let initialised = false;

export function markAnalyticsReady(): void {
  initialised = true;
}

export function capture(
  event: AnalyticsEventName,
  properties?: Record<string, unknown>,
): void {
  if (!initialised) return;
  posthog.capture(event, properties);
}

/**
 * The Endstate installer format a /download URL resolves to.
 * Mirrors ALLOWED_FORMATS in src/app/api/download/route.ts — that route defaults
 * anything unrecognised to exe, so this reports what the user will actually get.
 */
export function downloadFormat(url: URL): "exe" | "msi" {
  return url.searchParams.get("format")?.toLowerCase() === "msi" ? "msi" : "exe";
}

/**
 * Whether a URL is the Endstate installer download.
 *
 * Deliberately an exact pathname match: /downloads/<cv>.pdf on /work and
 * /api/exomem/exports/:id/download are unrelated and must not be counted as
 * Endstate installs.
 */
export function isEndstateDownload(url: URL): boolean {
  return url.pathname === "/download";
}
