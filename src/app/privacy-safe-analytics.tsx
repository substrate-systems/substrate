"use client";

import { Analytics } from "@vercel/analytics/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import {
  filterVercelAnalyticsEvent,
  shouldMountAnalytics,
  shouldReloadAnalyticsDocument,
} from "@/lib/exomem-hosted/privacy";

export function PrivacySafeAnalytics() {
  const pathname = usePathname();
  const analyticsEnabled = shouldMountAnalytics(pathname);
  const analyticsWasMountedRef = useRef(false);

  useEffect(() => {
    if (shouldReloadAnalyticsDocument(analyticsWasMountedRef.current, pathname)) {
      window.location.replace(window.location.href);
      return;
    }
    if (analyticsEnabled) analyticsWasMountedRef.current = true;
  }, [analyticsEnabled, pathname]);

  if (!analyticsEnabled) return null;
  return <Analytics beforeSend={filterVercelAnalyticsEvent} />;
}
