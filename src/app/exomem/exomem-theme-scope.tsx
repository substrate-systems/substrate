"use client";

import { useLayoutEffect } from "react";
import { applyExomemTheme, clearExomemTheme } from "@/lib/exomem/theme";

/**
 * Keeps the Exomem marker and theme on <html> for exactly as long as an /exomem page
 * is shown. A full page load gets them from the root layout's inline script; this
 * covers client-side navigation into /exomem and removes them on the way out.
 * A layout effect runs before the browser paints the new route, so nothing flashes.
 */
export function ExomemThemeScope() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    applyExomemTheme(root);
    return () => clearExomemTheme(root);
  }, []);
  return null;
}
