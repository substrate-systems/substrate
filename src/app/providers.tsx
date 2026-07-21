"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { filterPostHogCapture, shouldMountAnalytics } from "@/lib/exomem-hosted/privacy";
import {
  AnalyticsEvent,
  capture,
  downloadFormat,
  isEndstateDownload,
  markAnalyticsReady,
} from "@/lib/analytics";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
let postHogInitialized = false;

/**
 * Pageview capture, isolated so useSearchParams can be Suspense-wrapped.
 *
 * useSearchParams opts its whole subtree into client rendering. Calling it in
 * PostHogProvider — which wraps the entire app from the root layout — would
 * deopt every route out of static generation, which the blog and sitemap
 * depend on. Keeping it in a leaf under <Suspense> confines that to this node.
 *
 * Query strings matter here: pathname alone misses UTM-tagged landings reached
 * via client-side navigation, which is exactly how launch traffic arrives.
 */
function PostHogPageView({ enabled }: { enabled: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!enabled) return;
    posthog.capture("$pageview", { $current_url: window.location.href });
  }, [enabled, pathname, searchParams]);

  return null;
}

/**
 * Product analytics. No-ops entirely when NEXT_PUBLIC_POSTHOG_KEY is unset, so the
 * site runs identically without a key configured. Set the key in Vercel env to enable.
 * Private Exomem routes never mount the SDK provider. Public pageviews are emitted
 * explicitly so an SDK initialized on a public page cannot observe later private navigation.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const analyticsEnabled = Boolean(POSTHOG_KEY) && shouldMountAnalytics(pathname);

  useEffect(() => {
    if (!analyticsEnabled || !POSTHOG_KEY) return;
    if (postHogInitialized) return;
    posthog.init(POSTHOG_KEY, {
      // Same-origin ingest. Hitting the PostHog host directly gets blocked by
      // the ad blockers and DNS filters common among Windows power users, which
      // is precisely the audience being measured — the loss is silent and
      // biased, not random. The /ingest rewrites live in next.config.ts.
      api_host: "/ingest",
      // Without this, links in the PostHog UI point at /ingest instead of the app.
      ui_host: POSTHOG_HOST,
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: true,
      // Session replay stays off pending a privacy pass — it records DOM
      // content, so it needs masking rules before it can touch account pages.
      disable_session_recording: true,
      capture_performance: true,
      capture_exceptions: true,
      person_profiles: "identified_only",
      before_send: (capture) => filterPostHogCapture(capture, window.location.href),
    });
    postHogInitialized = true;
    markAnalyticsReady();
  }, [analyticsEnabled]);

  // Download intent, captured once for every link that resolves to /download.
  // Delegated rather than bound per link: the installer CTA appears in six
  // files, and a listener on the document also covers links added later.
  useEffect(() => {
    if (!analyticsEnabled) return;

    function onClick(event: MouseEvent) {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (!isEndstateDownload(url)) return;

      capture(AnalyticsEvent.DownloadClicked, {
        format: downloadFormat(url),
        // Where on the site the install was initiated from, so the landing page
        // and the apps page can be compared as conversion surfaces.
        source_path: window.location.pathname,
      });
    }

    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, [analyticsEnabled]);

  if (!analyticsEnabled) return <>{children}</>;
  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView enabled={analyticsEnabled} />
      </Suspense>
      {children}
    </PHProvider>
  );
}
