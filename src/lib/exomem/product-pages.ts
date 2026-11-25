/**
 * The public product page routes under src/app/exomem (the landing page is the bare path).
 * Kept in code on purpose: it mirrors route files, which only a code change adds. The routing
 * (product-site.ts), the sitemap and the theme rule all read it, so a new page needs one edit.
 * The theme's inline script bundles this file, so it has no imports.
 */
export const PRODUCT_PUBLIC_PAGES = ["docs", "benchmarks", "privacy", "terms", "support"] as const;

export type ProductPublicPage = (typeof PRODUCT_PUBLIC_PAGES)[number];

/** A product page path at the root of the product site: "/" or "/<public page>". */
export function isProductRootPath(pathname: string): boolean {
  return (
    pathname === "/" || (PRODUCT_PUBLIC_PAGES as readonly string[]).includes(pathname.slice(1))
  );
}
