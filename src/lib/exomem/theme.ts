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
 * The inline <head> script for the root layout. It marks only /exomem and its
 * children, so the rest of the site never receives the Exomem tokens.
 */
export const exomemThemeScript = `(function(){var p=location.pathname;if(p==="/exomem"||p.indexOf("/exomem/")===0)(${applyStoredTheme.toString()})(${JSON.stringify(STORAGE_KEY)},document.documentElement)})()`;

/** Marks <html> for an Exomem page after a client-side navigation into /exomem. */
export function applyExomemTheme(root: HTMLElement): ExomemTheme {
  return applyStoredTheme(STORAGE_KEY, root);
}

/** Removes the marker and theme when a client-side navigation leaves /exomem. */
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
