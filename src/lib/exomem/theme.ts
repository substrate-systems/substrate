// The site-wide Exomem theme preference. One key in localStorage holds "light" or
// "dark"; dark is the default. The theme is applied as data-theme on <html>, beside
// the data-exomem marker that scopes the Exomem tokens and scrollbar to /exomem/**.

export type ExomemTheme = "dark" | "light";

const STORAGE_KEY = "exomem-theme";

/**
 * Reads the stored preference and marks <html> as an Exomem page in that theme.
 * Anything but "light" is dark, including storage that throws (blocked or private).
 *
 * The root layout also runs this as an inline script before first paint, through
 * `toString()`, so it must stay self-contained: no imports and no outer variables.
 */
function applyStoredTheme(storageKey: string, root: HTMLElement): ExomemTheme {
  let theme: ExomemTheme = "dark";
  try {
    if (window.localStorage.getItem(storageKey) === "light") theme = "light";
  } catch {
    // Storage is unavailable: keep the default.
  }
  root.setAttribute("data-exomem", "");
  root.setAttribute("data-theme", theme);
  return theme;
}

/**
 * Whether a path is an Exomem page: /exomem and everything under it, its 404s
 * included. The rest of the site never receives the Exomem marker or tokens.
 * Self-contained for the same reason as applyStoredTheme: the inline script embeds it.
 */
export function isExomemPath(pathname: string): boolean {
  return pathname === "/exomem" || pathname.indexOf("/exomem/") === 0;
}

/** The inline <head> script for the root layout: the same two functions, before first paint. */
export const exomemThemeScript = `(function(){if((${isExomemPath.toString()})(location.pathname))(${applyStoredTheme.toString()})(${JSON.stringify(STORAGE_KEY)},document.documentElement)})()`;

/** Marks <html> for an Exomem page reached by a client-side navigation. */
export function applyExomemTheme(root: HTMLElement): ExomemTheme {
  return applyStoredTheme(STORAGE_KEY, root);
}

/** Removes the marker and theme when a client-side navigation leaves the Exomem pages. */
export function clearExomemTheme(root: HTMLElement): void {
  root.removeAttribute("data-exomem");
  root.removeAttribute("data-theme");
}

/** Switches the theme now and remembers it for every Exomem page. */
export function setExomemTheme(root: HTMLElement, theme: ExomemTheme): void {
  root.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage is unavailable: the switch still holds for this page.
  }
}
