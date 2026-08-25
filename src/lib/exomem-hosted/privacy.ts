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
  "/exomem/authorize",
  "/exomem/sign-in",
  "/exomem/home",
  "/exomem/adopt",
  "/exomem/operator",
  "/exomem/account",
  "/exomem/billing",
  "/exomem/export",
  "/exomem/restore",
  "/exomem/delete",
] as const;

/** Exposed so the coverage test can compare against the routes on disk. */
export const privateExomemPaths: readonly string[] = PRIVATE_EXOMEM_PATHS;

/**
 * Authenticated surfaces outside the Exomem namespace that render a secret or an
 * identifier as page text.
 *
 * These are deliberately *not* added to `PRIVATE_EXOMEM_PATHS`. Analytics stays
 * on here — pageviews and the deliberate events these pages fire are audited to
 * carry no secret, and the claim page's handoff events are the only measurement
 * of whether that flow works at all. What is turned off is `autocapture`, which
 * records `$el_text` for clicked elements and is the one mechanism that could
 * lift a rendered value without anyone choosing to send it.
 *
 * - `/endstate/claim/*` renders a live claim token (a credential).
 * - `/account` renders the account holder's email address.
 *
 * Note on copy capture: posthog-js only captures cut/copied text when
 * `autocapture.capture_copied_text` is explicitly true. It is not set, so the
 * claim token is not captured on copy — which matters, because copying it is the
 * page's entire purpose. Turning autocapture off here also removes that as a
 * future footgun.
 */
const SENSITIVE_TEXT_PATHS = ["/account", "/endstate/claim"] as const;

export const sensitiveTextPaths: readonly string[] = SENSITIVE_TEXT_PATHS;

/**
 * `autocapture.url_ignorelist` entries for the surfaces above.
 *
 * Anchored on the path and tolerant of a trailing segment, query or hash, so
 * `/endstate/claim/<token>` and `/account?x=1` both match. Regexes rather than
 * plain strings because posthog-js treats string entries as substring matches
 * against the whole URL, which would be looser than intended.
 *
 * Deliberately does not set `css_selector_ignorelist`: supplying one replaces
 * posthog-js's defaults (`.ph-no-autocapture`, `[data-ph-no-autocapture]`)
 * wholesale, which would quietly remove protection elsewhere.
 */
export const autocaptureUrlIgnorelist: RegExp[] = SENSITIVE_TEXT_PATHS.map((path) => {
  // posthog-js tests these against the whole URL, so `^` cannot anchor them.
  // Anchoring on the `//host` boundary instead keeps `/foo/account` from
  // matching `/account`, while the trailing class stops `/accounts` matching.
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\/\\/[^\\/]+${escaped}(?:[/?#]|$)`);
});

/** True when a URL renders secret or identifying text and must not be autocaptured. */
export function isSensitiveTextPath(value: string): boolean {
  const path = pathname(value);
  if (!path) return false;
  return SENSITIVE_TEXT_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

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
