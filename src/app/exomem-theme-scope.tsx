"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect } from "react";
import { applyExomemTheme, clearExomemTheme, isExomemPath } from "@/lib/exomem/theme";

/**
 * Keeps the Exomem marker and theme on <html> exactly while the path is an Exomem
 * page, by the same rule as the inline script that sets them on a full page load.
 * It lives in the root layout, so it also runs on pages outside the Exomem layout
 * tree, such as the root 404. A layout effect runs before the browser paints the
 * new route, so nothing flashes.
 */
export function ExomemThemeScope() {
  const pathname = usePathname();
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!isExomemPath(pathname ?? "")) clearExomemTheme(root);
    // Already marked: keep the theme the page has (a toggle may have changed it).
    else if (!root.hasAttribute("data-exomem")) applyExomemTheme(root);
  }, [pathname]);
  return null;
}
