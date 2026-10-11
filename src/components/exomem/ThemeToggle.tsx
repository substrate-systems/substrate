"use client";

import { useSyncExternalStore } from "react";
import { setExomemTheme, type ExomemTheme } from "@/lib/exomem/theme";
import { IconButton } from "./IconButton";

// Every toggle on the page follows the theme on <html>, whoever changed it.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function currentTheme(): ExomemTheme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

// The server renders the default; the client corrects it on hydration.
function serverTheme(): ExomemTheme {
  return "dark";
}

/** The one site-wide theme switch: a borderless half-moon in a 28 px button. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, serverTheme);
  const next: ExomemTheme = theme === "light" ? "dark" : "light";
  return (
    <IconButton
      label={next === "light" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setExomemTheme(document.documentElement, next)}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 1.8 A6.2 6.2 0 0 1 8 14.2 Z" fill="currentColor" />
      </svg>
    </IconButton>
  );
}
