import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import {
  matchHas,
  prepareDestination,
} from "next/dist/shared/lib/router/utils/prepare-destination";
import {
  appPagePathOn,
  exomemHomeUrl,
  exomemPageUrl,
  exomemPublicFragmentUrl,
} from "../../exomem-hosted/public-origin";
import nextConfig from "../../../../next.config";
import { PRODUCT_APP_PAGES, PRODUCT_PUBLIC_PAGES } from "../product-pages";
import { productPageUrl, productSiteRoutes } from "../product-site";

const ON = { EVERMATTER_SITE_ORIGIN: "https://evermatter.ai" };
// After the switch: sign-in and the OAuth issuer live on the product site.
const SWITCHED = { ...ON, EXOMEM_PUBLIC_BASE_URL: "https://evermatter.ai" };
const APP_PAGES = ["/exomem/authorize", "/exomem/sign-in", "/exomem/setup", "/exomem/home"];
const API_ROUTES = [
  "/api/exomem/oauth/authorize",
  "/api/exomem/oauth/token",
  "/api/exomem/oauth/register",
  "/api/exomem/account",
  "/.well-known/oauth-authorization-server/api/exomem/oauth",
];

const HOSTS = ["evermatter.ai", "www.evermatter.ai", "substratesystems.io"];
const PRODUCT_PATHS = [
  "/",
  "/exomem",
  "/exomem/og",
  ...PRODUCT_PUBLIC_PAGES.flatMap((page) => [`/${page}`, `/exomem/${page}`]),
  ...PRODUCT_APP_PAGES.flatMap((page) => [`/${page}`, `/exomem/${page}`, `/${page}/deeper`]),
];

type Rule = {
  source: string;
  destination: string;
  has: { type: "host"; value: string }[];
  permanent?: boolean;
};

// Applies the rules with Next's own matcher, host check and destination builder, as its router
// does: the first rule whose path and host match wins. A redirect gets the request's query
// appended; a rewrite answers with the path that serves. `permanent` says whether a browser may
// keep the redirect.
function match(
  rules: Rule[],
  host: string,
  url: string
): { to: string; permanent: boolean } | null {
  const request = new URL(url, "https://placeholder.invalid");
  const query = Object.fromEntries(request.searchParams);
  for (const rule of rules) {
    const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(
      request.pathname
    );
    if (!params) continue;
    const req = { headers: { host } } as unknown as IncomingMessage;
    if (!matchHas(req, query, rule.has)) continue;
    const { parsedDestination: to } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query,
    });
    const search = new URLSearchParams(to.query as Record<string, string>).toString();
    const origin = to.hostname ? `${to.protocol}//${to.hostname}` : "";
    return {
      to: `${origin}${to.pathname}${search ? `?${search}` : ""}`,
      permanent: !!rule.permanent,
    };
  }
  return null;
}

function resolve(rules: Rule[], host: string, url: string): string | null {
  return match(rules, host, url)?.to ?? null;
}

// The address a request finally lands on, and how many redirects it took to get there. Like a
// browser, it answers from `cached` first and keeps there each permanent redirect it follows.
function follow(
  env: Record<string, string>,
  host: string,
  url: string,
  cached = new Map<string, string>()
) {
  const { redirects } = productSiteRoutes(env);
  let at = { host, url };
  for (let hops = 0; hops <= 3; hops++) {
    const address = `https://${at.host}${at.url}`;
    const kept = cached.get(address);
    const next = kept ? { to: kept, permanent: true } : match(redirects, at.host, at.url);
    if (next === null) return { ...at, hops };
    const target = new URL(next.to, address);
    if (next.permanent) cached.set(address, target.toString());
    at = { host: target.host, url: `${target.pathname}${target.search}` };
  }
  throw new Error(`${host}${url} redirects more than three times`);
}

describe("product site routing", () => {
  it("adds no redirect or rewrite while the site is off", () => {
    assert.deepEqual(productSiteRoutes({}), { redirects: [], rewrites: [] });
    assert.equal(productPageUrl("/exomem/docs", {}), "https://substratesystems.io/exomem/docs");
  });

  it("keeps sign-in, consent and OAuth on the company site before the switch", () => {
    const { redirects, rewrites } = productSiteRoutes(ON);
    for (const path of [...APP_PAGES, ...API_ROUTES]) {
      assert.equal(resolve(redirects, "substratesystems.io", path), null, path);
      assert.equal(resolve(rewrites, "substratesystems.io", path), null, path);
    }
  });

  it("sends app pages on the product host to the company site before the switch, in either form", () => {
    const { redirects } = productSiteRoutes(ON);
    for (const path of ["/exomem/sign-in?next=1", "/sign-in?next=1"]) {
      assert.equal(
        resolve(redirects, "evermatter.ai", path),
        "https://substratesystems.io/exomem/sign-in?next=1",
        path
      );
    }
    assert.equal(
      resolve(redirects, "evermatter.ai", "/email-change/confirm"),
      "https://substratesystems.io/exomem/email-change/confirm"
    );
    assert.equal(resolve(redirects, "evermatter.ai", "/exomem/docs"), "/docs");
    assert.equal(resolve(redirects, "evermatter.ai", "/exomem/mark/dot-e.svg"), null);
  });

  it("serves the app pages at the product site's root after the switch", () => {
    const { redirects, rewrites } = productSiteRoutes(SWITCHED);
    for (const path of ["/home", "/sign-in", "/email-change/confirm", "/authorize/unknown-app"]) {
      assert.equal(resolve(redirects, "evermatter.ai", path), null, path);
      assert.equal(resolve(rewrites, "evermatter.ai", path), `/exomem${path}`, path);
    }
    // The company site has no page at those paths.
    assert.equal(resolve(rewrites, "substratesystems.io", "/home"), null);
  });

  it("redirects the old app addresses to the root form after the switch, keeping the query", () => {
    const { redirects } = productSiteRoutes(SWITCHED);
    assert.equal(
      resolve(redirects, "evermatter.ai", "/exomem/home?_ptxn=txn_1"),
      "/home?_ptxn=txn_1"
    );
    assert.equal(
      resolve(redirects, "substratesystems.io", "/exomem/authorize?confirmation=abc"),
      "https://evermatter.ai/authorize?confirmation=abc"
    );
    assert.equal(
      resolve(redirects, "www.substratesystems.io", "/exomem/email-change/confirm"),
      "https://evermatter.ai/email-change/confirm"
    );
    assert.equal(
      resolve(redirects, "substratesystems.io", "/exomem/docs"),
      "https://evermatter.ai/docs"
    );
    // A route that is no page (the OG image) keeps its form on the product site, where it serves.
    assert.equal(
      resolve(redirects, "substratesystems.io", "/exomem/og"),
      "https://evermatter.ai/exomem/og"
    );
    assert.equal(resolve(redirects, "evermatter.ai", "/exomem/og"), null);
    assert.equal(resolve(redirects, "substratesystems.io", "/exomem/mark/dot-e.svg"), null);
  });

  it("never rewrites or redirects an API or well-known route", () => {
    for (const env of [ON, SWITCHED]) {
      const { redirects, rewrites } = productSiteRoutes(env);
      for (const host of ["evermatter.ai", "substratesystems.io"]) {
        for (const path of API_ROUTES) {
          assert.equal(resolve(redirects, host, path), null, `${host}${path}`);
          assert.equal(resolve(rewrites, host, path), null, `${host}${path}`);
        }
      }
    }
  });

  it("ends every redirect at an address that serves, within two hops", () => {
    for (const env of [ON, SWITCHED]) {
      for (const host of HOSTS) {
        for (const path of PRODUCT_PATHS) {
          assert.ok(follow(env, host, path).hops <= 2, `${host}${path}`);
        }
      }
    }
  });

  it("never loops on a redirect that a browser kept from before the switch or a rollback", () => {
    // A browser keeps a 308 for good, and the app-page redirects between hosts reverse when
    // sign-in moves and when it moves back.
    for (const [before, after] of [
      [ON, SWITCHED],
      [SWITCHED, ON],
    ]) {
      const cached = new Map<string, string>();
      for (const host of HOSTS) {
        for (const path of PRODUCT_PATHS) follow(before, host, path, cached);
      }
      for (const host of HOSTS) {
        for (const path of PRODUCT_PATHS) {
          assert.doesNotThrow(() => follow(after, host, path, cached), `${host}${path}`);
        }
      }
    }
  });

  it("builds app addresses in the form their origin serves", () => {
    for (const [env, origin] of [
      [ON, "https://substratesystems.io"],
      [SWITCHED, "https://evermatter.ai"],
    ] as const) {
      const { rewrites } = productSiteRoutes(env);
      for (const page of PRODUCT_APP_PAGES) {
        const url = exomemPageUrl(origin, `/exomem/${page}?q=1`, env);
        const landed = follow(env, url.host, `${url.pathname}${url.search}`);
        assert.equal(landed.hops, 0, url.toString());
        const served = resolve(rewrites, url.host, url.pathname) ?? url.pathname;
        assert.equal(served, `/exomem/${page}`, url.toString());
      }
    }
    assert.equal(
      exomemPublicFragmentUrl("https://evermatter.ai", "/exomem/sign-in", "token", SWITCHED),
      "https://evermatter.ai/sign-in#token"
    );
    assert.equal(
      exomemPublicFragmentUrl("https://substratesystems.io", "/exomem/sign-in", "token", ON),
      "https://substratesystems.io/exomem/sign-in#token"
    );
    assert.equal(
      exomemHomeUrl("https://evermatter.ai", "your-data", SWITCHED),
      "https://evermatter.ai/home#your-data"
    );
    // A development origin is never the product site, whatever the site setting.
    assert.equal(
      exomemHomeUrl("http://localhost:3100", undefined, ON),
      "http://localhost:3100/exomem/home"
    );
    assert.equal(productPageUrl("/exomem/sign-in", SWITCHED), "https://evermatter.ai/sign-in");
  });

  // Home sends a checkout return to setup, and setup sends a signed-out person to sign-in.
  it("sends a server redirect where its host serves it, in one hop and with its query", () => {
    for (const [env, host] of [
      [ON, "substratesystems.io"],
      [SWITCHED, "evermatter.ai"],
    ] as const) {
      for (const route of ["/exomem/setup?_ptxn=txn_01", "/exomem/sign-in"]) {
        const path = appPagePathOn(host, route, env);
        assert.deepEqual(follow(env, host, path), { host, url: path, hops: 0 }, `${host}${route}`);
        assert.equal(
          new URL(path, "https://x.invalid").search,
          new URL(route, "https://x.invalid").search
        );
      }
    }
    assert.equal(appPagePathOn(null, "/exomem/sign-in", SWITCHED), "/exomem/sign-in");
  });

  it("keeps the operator page out of caches and search in both its forms", async () => {
    const rules = await nextConfig.headers!();
    for (const path of ["/exomem/operator", "/operator"]) {
      const sent = rules
        .filter((rule) => getPathMatch(rule.source, { strict: true })(path))
        .flatMap((rule) => rule.headers);
      assert.ok(
        sent.some((header) => header.key === "Cache-Control" && header.value.startsWith("private")),
        path
      );
    }
  });

  it("refuses a public base URL that is not a bare HTTPS origin", () => {
    assert.throws(() =>
      productSiteRoutes({ ...ON, EXOMEM_PUBLIC_BASE_URL: "https://evermatter.ai/app" })
    );
  });

  it("moves old public product links to the product site", () => {
    const { redirects } = productSiteRoutes(ON);
    assert.equal(resolve(redirects, "substratesystems.io", "/exomem"), "https://evermatter.ai/");
    assert.equal(
      resolve(redirects, "www.substratesystems.io", "/exomem/benchmarks"),
      "https://evermatter.ai/benchmarks"
    );
  });

  it("serves the product pages at the root of the product host", () => {
    const { rewrites, redirects } = productSiteRoutes(ON);
    assert.equal(resolve(rewrites, "evermatter.ai", "/"), "/exomem");
    assert.equal(resolve(rewrites, "evermatter.ai", "/terms"), "/exomem/terms");
    assert.equal(resolve(rewrites, "substratesystems.io", "/terms"), null);
    assert.equal(resolve(redirects, "www.evermatter.ai", "/docs"), "https://evermatter.ai/docs");
    assert.equal(productPageUrl("/exomem", ON), "https://evermatter.ai/");
    assert.equal(
      productPageUrl("/exomem/sign-in", ON),
      "https://substratesystems.io/exomem/sign-in"
    );
  });

  // A page left off both lists keeps its /exomem address on the product site, or 404s there.
  it("lists every page folder under src/app/exomem as a public or an app page", () => {
    const root = path.join(process.cwd(), "src/app/exomem");
    const hasPage = (dir: string): boolean =>
      existsSync(path.join(dir, "page.tsx")) ||
      readdirSync(dir, { withFileTypes: true }).some(
        (entry) => entry.isDirectory() && hasPage(path.join(dir, entry.name))
      );
    const folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .filter((entry) => hasPage(path.join(root, entry.name)))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(folders, [...PRODUCT_PUBLIC_PAGES, ...PRODUCT_APP_PAGES].sort());
  });
});
