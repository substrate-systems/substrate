/**
 * The public product page routes under src/app/exomem (the landing page is the bare path).
 * Kept in code on purpose: it mirrors route files, which only a code change adds. The routing
 * (product-site.ts), the sitemap and the theme rule all read it, so a new page needs one edit.
 * The theme's inline script bundles this file, so it has no imports.
 */
export const PRODUCT_PUBLIC_PAGES = ["docs", "benchmarks", "privacy", "terms", "support"] as const;

export type ProductPublicPage = (typeof PRODUCT_PUBLIC_PAGES)[number];

/**
 * The app page routes under src/app/exomem (sign-in, setup, Home, consent and the rest), by
 * their first path segment. They serve at the product site's root once the app origin is that
 * site. Kept in code for the reason above; a test compares both lists with the route folders.
 */
export const PRODUCT_APP_PAGES = [
  "access-log",
  "authorize",
  "delete",
  "design-system",
  "email-change",
  "email-preview",
  "home",
  "invite",
  "operator",
  "setup",
  "sign-in",
  "viewer",
] as const;

/** A root path that names an app page or a page below one: "/home", "/email-change/confirm". */
export function isProductAppRootPath(pathname: string): boolean {
  return (PRODUCT_APP_PAGES as readonly string[]).includes(pathname.split("/")[1] ?? "");
}

/** A product page path at the root of the product site: "/", "/<public page>" or an app page. */
export function isProductRootPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    (PRODUCT_PUBLIC_PAGES as readonly string[]).includes(pathname.slice(1)) ||
    isProductAppRootPath(pathname)
  );
}
