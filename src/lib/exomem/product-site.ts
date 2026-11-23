/**
 * The product's own public site (evermatter.ai). `EVERMATTER_SITE_ORIGIN` turns it on.
 * Unset, the product pages live only under /exomem on the company site, as before.
 * Set, the public product pages get their canonical home on that origin and their old
 * company-site paths redirect there. App pages (sign-in, setup, home, authorize) stay on
 * the company site, because the session cookie is host-only and the OAuth issuer lives there.
 *
 * next.config.ts imports this file, so it uses relative imports and no Next runtime APIs.
 */

const COMPANY_ORIGIN = "https://substratesystems.io";

// The public page routes under src/app/exomem (the landing page is the bare path). Kept in
// code on purpose: it mirrors route files, which only a code change adds.
export const PRODUCT_PUBLIC_PAGES = ["docs", "benchmarks", "privacy", "terms", "support"] as const;

type Env = Record<string, string | undefined>;

export function productSiteOrigin(env: Env = process.env): string | null {
  const raw = env.EVERMATTER_SITE_ORIGIN?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("EVERMATTER_SITE_ORIGIN must be a bare HTTPS origin");
  }
  return url.origin;
}

function publicPageOf(path: string): string | null {
  if (path === "/exomem") return "";
  const match = /^\/exomem\/([^/]+)$/.exec(path);
  const page = match?.[1];
  return page && (PRODUCT_PUBLIC_PAGES as readonly string[]).includes(page) ? `/${page}` : null;
}

/** The absolute URL a product page should canonicalise to; company origin when the site is off. */
export function productPageUrl(path: string, env: Env = process.env): string {
  const origin = productSiteOrigin(env);
  const page = origin ? publicPageOf(path) : null;
  if (origin && page !== null) return `${origin}${page || "/"}`;
  return `${COMPANY_ORIGIN}${path}`;
}

function hostPattern(hostname: string): string {
  return hostname.replace(/\./g, "\\.");
}

type Has = { type: "host"; value: string }[];
type Redirect = { source: string; destination: string; permanent: true; has: Has };
type Rewrite = { source: string; destination: string; has: Has };

/** Host-matched redirects and rewrites for next.config.ts; empty while the site is off. */
export function productSiteRoutes(env: Env = process.env): {
  redirects: Redirect[];
  rewrites: Rewrite[];
} {
  const origin = productSiteOrigin(env);
  if (!origin) return { redirects: [], rewrites: [] };
  const productHost = new URL(origin).hostname;
  const product: Has = [{ type: "host", value: hostPattern(productHost) }];
  const productWww: Has = [{ type: "host", value: hostPattern(`www.${productHost}`) }];
  const company: Has = [
    { type: "host", value: `(www\\.)?${hostPattern(new URL(COMPANY_ORIGIN).hostname)}` },
  ];
  const pages = PRODUCT_PUBLIC_PAGES.join("|");
  return {
    redirects: [
      { source: "/:path*", destination: `${origin}/:path*`, permanent: true, has: productWww },
      // On the product host, the /exomem prefix is redundant for public pages; any other
      // /exomem page is an app page and goes back to the company site.
      { source: "/exomem", destination: "/", permanent: true, has: product },
      { source: `/exomem/:page(${pages})`, destination: "/:page", permanent: true, has: product },
      // A dotted path is an asset (images, icons, the OG image); it serves on either host.
      {
        source: "/exomem/:path((?!.*\\.).*)",
        destination: `${COMPANY_ORIGIN}/exomem/:path`,
        permanent: true,
        has: product,
      },
      { source: "/exomem", destination: `${origin}/`, permanent: true, has: company },
      {
        source: `/exomem/:page(${pages})`,
        destination: `${origin}/:page`,
        permanent: true,
        has: company,
      },
    ],
    rewrites: [
      { source: "/", destination: "/exomem", has: product },
      { source: `/:page(${pages})`, destination: "/exomem/:page", has: product },
    ],
  };
}
