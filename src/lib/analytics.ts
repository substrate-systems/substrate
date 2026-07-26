import posthog from "posthog-js";
import { AnalyticsEvent, type AnalyticsEventName } from "./analytics-events";

/**
 * Client-side product analytics.
 *
 * The event taxonomy lives in `./analytics-events` so server code can share it
 * without importing `posthog-js`. Every call here no-ops when PostHog was never
 * initialised (no key configured), so callers do not need to guard.
 */
export { AnalyticsEvent };
export type { AnalyticsEventName };

/**
 * Set by PostHogProvider once init has run. Tracked here rather than reading
 * posthog.__loaded so we depend on our own initialisation, not an SDK internal.
 */
let initialised = false;

export function markAnalyticsReady(): void {
  initialised = true;
}

export function capture(event: AnalyticsEventName, properties?: Record<string, unknown>): void {
  if (!initialised) return;
  try {
    posthog.capture(event, properties);
  } catch (err) {
    // Analytics must never break the flow it is observing. The checkout path is
    // the case that matters: a throwing capture must not stop a purchase.
    console.error("[analytics] capture_failed", { event, error: String(err) });
  }
}

/**
 * Attach subsequent events to a known account.
 *
 * Called only where an authenticated session already established the identity —
 * currently the hosted-backup account surface. Deliberately NOT called on the
 * claim page: the only identifier available there is the claim token, which is a
 * credential, and a distinct_id is permanent and unredactable once sent.
 *
 * Supporter-licence holders without a hosted-backup account stay anonymous.
 * That is correct: their funnels still work on the anonymous distinct_id, and
 * inventing a second identity space would merge two different people the first
 * time someone holds both.
 */
export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!initialised || !userId) return;
  posthog.identify(userId, properties);
}

/**
 * Drop the identified person on sign-out so the next visitor on a shared device
 * is not attributed to the previous user.
 */
export function resetIdentity(): void {
  if (!initialised) return;
  posthog.reset();
}

/**
 * The anonymous distinct_id, for threading an identity across a boundary the
 * SDK cannot follow — a Paddle checkout, or a redirect off-site.
 *
 * Returns null when the SDK is uninitialised or blocked. Every caller must treat
 * null as normal rather than exceptional: ad blockers skew hardest among Windows
 * power users, which is exactly the Endstate audience.
 */
export function currentDistinctId(): string | null {
  if (!initialised) return null;
  try {
    const id = posthog.get_distinct_id();
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
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
