/**
 * The complete event taxonomy, client and server, in one greppable place.
 *
 * This module deliberately has no imports. `src/lib/analytics.ts` pulls in
 * `posthog-js`, so route handlers and webhooks cannot import from there without
 * dragging the browser SDK into a server bundle. Keeping the names here lets both
 * sides share one vocabulary at zero cost.
 *
 * Naming: `<noun>_<past-tense-verb>`, lower snake case. Past tense because an
 * event records something that already happened.
 */

/** Events captured from the browser. */
export const AnalyticsEvent = {
  /** Intent to install: a click on any link resolving to /download. */
  DownloadClicked: "download_clicked",

  /** Purchase intent: the buy control was activated, before Paddle opens. */
  CheckoutStarted: "checkout_started",
  /** Paddle reported a completed transaction in its own callback. */
  CheckoutCompleted: "checkout_completed",
  /**
   * Any checkout-path failure. Always carries `stage` so SDK-init, open and
   * retry failures stay distinguishable without three separate event names.
   */
  CheckoutFailed: "checkout_failed",

  /** The claim page's "open in Endstate" control was activated. */
  ClaimHandoffOpened: "claim_handoff_opened",
  /** The claim code was copied from the claim page. */
  ClaimCodeCopied: "claim_code_copied",

  /** A settled search on the supported-apps page. Debounced, not per keystroke. */
  AppsSearched: "apps_searched",
  /** A settled search that matched nothing — unmet demand, queried directly. */
  AppsSearchNoResults: "apps_search_no_results",

  /**
   * A blog post was actually read rather than bounced. Fires once per post per
   * page view; see `useArticleRead` for the threshold.
   */
  ArticleRead: "article_read",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/**
 * Events captured on the server, where the browser cannot be trusted to report
 * or is not involved at all.
 */
export const ServerEvent = {
  /** The installer redirect resolved and the user was sent to the artifact. */
  DownloadServed: "download_served",
  /** The installer could not be resolved — the most urgent signal this app has. */
  DownloadFailed: "download_failed",

  /** A Paddle subscription transition, captured after state is persisted. */
  SubscriptionChanged: "subscription_changed",
  /** A supporter licence purchase completed. */
  LicensePurchased: "license_purchased",
  /** A licence key was activated against a machine. */
  LicenseActivated: "license_activated",

  /** A scheduled job finished. Carries `job` and `outcome`. */
  CronCompleted: "cron_completed",

  /**
   * An aggregate count of update checks. Carries no identifier of any kind —
   * see `updates/latest.json` and its contract test. The local product's
   * no-telemetry commitment is inviolable, so this counts requests the server
   * already receives and nothing more.
   */
  UpdateChecked: "update_checked",
} as const;

export type ServerEventName = (typeof ServerEvent)[keyof typeof ServerEvent];
