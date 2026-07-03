"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * Product analytics. No-ops entirely when NEXT_PUBLIC_POSTHOG_KEY is unset, so the
 * site runs identically without a key configured. Set the key in Vercel env to enable.
 * posthog-js captures SPA pageviews/pageleaves automatically via the history API.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!POSTHOG_KEY) return;
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      capture_pageleave: true,
      person_profiles: "identified_only",
    });
  }, []);

  if (!POSTHOG_KEY) return <>{children}</>;
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
