import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { productPageUrl, productSiteRoutes } from "../product-site";

// The matcher Next applies to redirects and rewrites; Next bundles it without type declarations.
const { compile, match } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as {
  match: (source: string, options: object) => (path: string) => false | { params: object };
  compile: (source: string, options: object) => (params: object) => string;
};

const ON = { EVERMATTER_SITE_ORIGIN: "https://evermatter.ai" };
// After the switch: sign-in and the OAuth issuer live on the product site.
const SWITCHED = { ...ON, EXOMEM_PUBLIC_BASE_URL: "https://evermatter.ai" };
const APP_PAGES = ["/exomem/authorize", "/exomem/sign-in", "/exomem/setup", "/exomem/home"];
const OAUTH_ROUTES = [
  "/api/exomem/oauth/authorize",
  "/api/exomem/oauth/token",
  "/.well-known/oauth-authorization-server/api/exomem/oauth",
];

type Rule = { source: string; destination: string; has: { value: string }[] };

// Resolves a request the way Next applies these rules: the first rule whose host and path
// match wins, and its destination is filled from the path's parameters.
function resolve(rules: Rule[], host: string, path: string): string | null {
  for (const rule of rules) {
    if (!rule.has.every((h) => new RegExp(`^${h.value}$`).test(host))) continue;
    const hit = match(rule.source, { decode: decodeURIComponent })(path);
    if (!hit) continue;
    const dest = new URL(rule.destination, "https://placeholder.invalid");
    const filled = compile(dest.pathname, { validate: false })(hit.params);
    return dest.host === "placeholder.invalid" ? filled : `${dest.origin}${filled}`;
  }
  return null;
}

describe("product site routing", () => {
  it("adds no redirect or rewrite while the site is off", () => {
    assert.deepEqual(productSiteRoutes({}), { redirects: [], rewrites: [] });
    assert.equal(productPageUrl("/exomem/docs", {}), "https://substratesystems.io/exomem/docs");
  });

  it("keeps sign-in, consent and OAuth on the company site before the switch", () => {
    const { redirects } = productSiteRoutes(ON);
    for (const path of [...APP_PAGES, ...OAUTH_ROUTES]) {
      assert.equal(resolve(redirects, "substratesystems.io", path), null, path);
    }
  });

  it("moves sign-in to the product site after the switch, with OAuth answering on both hosts", () => {
    const { redirects } = productSiteRoutes(SWITCHED);
    for (const path of APP_PAGES) {
      assert.equal(resolve(redirects, "substratesystems.io", path), `https://evermatter.ai${path}`);
      assert.equal(resolve(redirects, "evermatter.ai", path), null, path);
    }
    for (const path of OAUTH_ROUTES) {
      assert.equal(resolve(redirects, "substratesystems.io", path), null, path);
      assert.equal(resolve(redirects, "evermatter.ai", path), null, path);
    }
    assert.equal(
      resolve(redirects, "substratesystems.io", "/exomem/docs"),
      "https://evermatter.ai/docs"
    );
    assert.equal(resolve(redirects, "substratesystems.io", "/exomem/mark/dot-e.svg"), null);
    assert.equal(
      productPageUrl("/exomem/sign-in", SWITCHED),
      "https://evermatter.ai/exomem/sign-in"
    );
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

  it("sends app pages opened on the product host back to the company site", () => {
    const { redirects } = productSiteRoutes(ON);
    assert.equal(
      resolve(redirects, "evermatter.ai", "/exomem/sign-in"),
      "https://substratesystems.io/exomem/sign-in"
    );
    assert.equal(resolve(redirects, "evermatter.ai", "/exomem/docs"), "/docs");
    assert.equal(resolve(redirects, "evermatter.ai", "/exomem/mark/dot-e.svg"), null);
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
});
