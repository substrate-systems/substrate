"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { filterPostHogCapture, shouldMountAnalytics } from "@/lib/exomem-hosted/privacy";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";
let postHogInitialized = false;

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
    if (!postHogInitialized) {
      posthog.init(POSTHOG_KEY, {
        api_host: POSTHOG_HOST,
        capture_pageview: false,
        capture_pageleave: false,
        autocapture: false,
        disable_session_recording: true,
        capture_performance: false,
        capture_exceptions: false,
        person_profiles: "identified_only",
        before_send: (capture) => filterPostHogCapture(capture, window.location.href),
      });
      postHogInitialized = true;
    }
    posthog.capture("$pageview", { $current_url: window.location.href });
  }, [analyticsEnabled, pathname]);

  if (!analyticsEnabled) return <>{children}</>;
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
