/**
 * The product's own public site (evermatter.ai). `EVERMATTER_SITE_ORIGIN` turns it on.
 * Unset, the product pages live only under /exomem on the company site, as before.
 * Set, the public product pages serve at that origin's root and their old company-site paths
 * redirect there. App pages (sign-in, setup, Home, consent, operator and the rest) serve on the
 * origin `EXOMEM_PUBLIC_BASE_URL` names, which also gives the OAuth issuer: at its root when that
 * origin is the product site, under /exomem anywhere else. Every other host and form redirects
 * to that address. API and /.well-known routes are never redirected or rewritten; authorize
 * redirects a GET on another host to the base origin itself (its route.ts).
 *
 * next.config.ts imports this file, so it uses relative imports and no Next runtime APIs.
 */

import {
  exomemPageUrl,
  parseExomemPublicBaseUrl,
  productSiteOrigin,
} from "../exomem-hosted/public-origin";
import { PRODUCT_APP_PAGES, PRODUCT_PUBLIC_PAGES } from "./product-pages";

const COMPANY_ORIGIN = "https://substratesystems.io";

type Env = Record<string, string | undefined>;

/** The product site's host for the theme rule on <html>, or null while the site is off. */
export function productSiteHost(env: Env = process.env): string | null {
  const origin = productSiteOrigin(env);
  return origin ? new URL(origin).hostname : null;
}

/** Where the app pages and the OAuth issuer live; the company site while the value is unset. */
function productAppOrigin(env: Env = process.env): string {
  const raw = env.EXOMEM_PUBLIC_BASE_URL?.trim();
  return raw
    ? parseExomemPublicBaseUrl(raw, env.NODE_ENV as NodeJS.ProcessEnv["NODE_ENV"])
    : COMPANY_ORIGIN;
}

function isPublicPage(path: string): boolean {
  if (path === "/exomem") return true;
  const page = /^\/exomem\/([^/]+)$/.exec(path)?.[1];
  return page !== undefined && (PRODUCT_PUBLIC_PAGES as readonly string[]).includes(page);
}

/** The absolute URL a product page should canonicalise to; company origin when the site is off. */
export function productPageUrl(path: string, env: Env = process.env): string {
  const origin = productSiteOrigin(env);
  const home = origin && isPublicPage(path) ? origin : productAppOrigin(env);
  return exomemPageUrl(home, path, env).toString();
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
  const appOrigin = productAppOrigin(env);
  // The www hosts redirect to their bare host, so an app origin on one would loop every app page.
  const appHost = new URL(appOrigin).hostname;
  if (appHost === `www.${productHost}` || appHost === `www.${new URL(COMPANY_ORIGIN).hostname}`) {
    throw new Error("EXOMEM_PUBLIC_BASE_URL must name a bare host, not a www host");
  }
  const product: Has = [{ type: "host", value: hostPattern(productHost) }];
  const productWww: Has = [{ type: "host", value: hostPattern(`www.${productHost}`) }];
  const company: Has = [
    { type: "host", value: `(www\\.)?${hostPattern(new URL(COMPANY_ORIGIN).hostname)}` },
  ];
  const pages = PRODUCT_PUBLIC_PAGES.join("|");
  const apps = PRODUCT_APP_PAGES.join("|");
  // The app pages sit at the product site's root only while the app origin is that site.
  const appsAtRoot = appOrigin === origin;
  const appPage = `/:page(${apps})/:path*`;
  const prefixedAppPage = `/exomem/:page(${apps})/:path*`;
  const appPageHome = appsAtRoot ? `${appOrigin}/:page/:path*` : `${appOrigin}/exomem/:page/:path*`;
  // Any other /exomem path (the OG image, a retired page) keeps its form on the app origin. A
  // dotted path is an asset (images, icons); it serves on either host.
  const otherPath = "/exomem/:path((?!.*\\.).*)";
  const redirect = (source: string, destination: string, has: Has): Redirect => ({
    source,
    destination,
    permanent: true,
    has,
  });
  return {
    redirects: [
      redirect("/:path*", `${origin}/:path*`, productWww),
      // On the product host, the /exomem prefix is redundant for public pages, and for app
      // pages while they serve there; otherwise app pages serve only on the app origin.
      redirect("/exomem", "/", product),
      redirect(`/exomem/:page(${pages})`, "/:page", product),
      ...(appsAtRoot
        ? [redirect(prefixedAppPage, "/:page/:path*", product)]
        : [
            redirect(appPage, appPageHome, product),
            redirect(otherPath, `${appOrigin}/exomem/:path`, product),
          ]),
      redirect("/exomem", `${origin}/`, company),
      redirect(`/exomem/:page(${pages})`, `${origin}/:page`, company),
      ...(appOrigin === COMPANY_ORIGIN
        ? []
        : [
            redirect(prefixedAppPage, appPageHome, company),
            redirect(otherPath, `${appOrigin}/exomem/:path`, company),
          ]),
    ],
    rewrites: [
      { source: "/", destination: "/exomem", has: product },
      { source: `/:page(${pages})`, destination: "/exomem/:page", has: product },
      ...(appsAtRoot
        ? [{ source: appPage, destination: "/exomem/:page/:path*", has: product }]
        : []),
    ],
  };
}
