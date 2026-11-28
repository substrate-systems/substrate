import { isProductRootPath } from "../exomem/product-pages";
import { ExomemHostedError } from "./errors";

type Env = Record<string, string | undefined>;

const DEVELOPMENT_DEFAULT_ORIGIN = "https://substratesystems.io";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function invalidPublicBaseUrl(): ExomemHostedError {
  return new ExomemHostedError({
    code: "PUBLIC_BASE_URL_INVALID",
    status: 500,
    message: "public Evermatter URL configuration is invalid",
  });
}

export function parseExomemPublicBaseUrl(
  value: string | undefined,
  environment = process.env.NODE_ENV
): string {
  const configured =
    value ?? (environment === "production" ? undefined : DEVELOPMENT_DEFAULT_ORIGIN);
  if (!configured) throw invalidPublicBaseUrl();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw invalidPublicBaseUrl();
  }
  const safeHttps = url.protocol === "https:";
  const safeDevelopmentHttp =
    environment !== "production" && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (
    (!safeHttps && !safeDevelopmentHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw invalidPublicBaseUrl();
  }
  return url.origin;
}

export function exomemPublicBaseUrlFromEnv(): string {
  return parseExomemPublicBaseUrl(process.env.EXOMEM_PUBLIC_BASE_URL);
}

/**
 * The product's own site (`EVERMATTER_SITE_ORIGIN`, evermatter.ai), or null while it is off.
 * product-site.ts routes it; the page addresses below follow it. The gateway reads the setting
 * as `EXOMEM_SITE_ORIGIN`, because its startup renames every `EVERMATTER_` setting
 * (exomem-gateway/env-aliases.ts).
 */
export function productSiteOrigin(env: Env = process.env): string | null {
  const raw = (env.EVERMATTER_SITE_ORIGIN ?? env.EXOMEM_SITE_ORIGIN)?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("EVERMATTER_SITE_ORIGIN must be a bare HTTPS origin");
  }
  return url.origin;
}

/**
 * The address of a product page on `origin`, from its route path under /exomem (with any query
 * or fragment). The product site serves its pages at the root, so the prefix goes there; every
 * other origin (the company site, a development host) serves them under /exomem.
 */
export function exomemPageUrl(origin: string, path: string, env: Env = process.env): URL {
  const url = new URL(path, `${origin}/`);
  if (url.origin !== productSiteOrigin(env)) return url;
  const rest = url.pathname.slice("/exomem".length);
  if (url.pathname === "/exomem") url.pathname = "/";
  else if (url.pathname.startsWith("/exomem/") && isProductRootPath(rest)) url.pathname = rest;
  return url;
}

/**
 * A route path as the same-origin path that `host` serves it at, for a server redirect, so the
 * browser makes one hop instead of a second 308. An absent or malformed Host keeps the route form,
 * which every host still answers.
 */
export function appPagePathOn(
  host: string | null,
  routePath: string,
  env: Env = process.env
): string {
  if (!host) return routePath;
  try {
    const url = exomemPageUrl(`https://${host}`, routePath, env);
    return `${url.pathname}${url.search}`;
  } catch {
    return routePath;
  }
}

/** A page's address on the public base origin, where sign-in, consent and Home serve. */
export function exomemPublicPageUrl(path: string): URL {
  return exomemPageUrl(exomemPublicBaseUrlFromEnv(), path);
}

export function exomemPublicFragmentUrl(
  baseUrl: string,
  path: string,
  token: string,
  env: Env = process.env
): string {
  const url = exomemPageUrl(parseExomemPublicBaseUrl(baseUrl), path, env);
  url.hash = token;
  return url.toString();
}

/** Home's address under a public base URL, with an optional link target within the page. */
export function exomemHomeUrl(
  publicBaseUrl: string,
  fragment?: string,
  env: Env = process.env
): string {
  const url = exomemPageUrl(publicBaseUrl, "/exomem/home", env);
  if (fragment) url.hash = fragment;
  return url.toString();
}
