import { extname } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { productSiteHost } from "@/lib/exomem/product-site";
import { isExomemPath } from "@/lib/exomem/theme";
import { exomemThemeCookieName, themeBindingFromCsrfToken } from "@/lib/exomem/theme-binding";
import { EXOMEM_SESSION_COOKIE, EXOMEM_CSRF_COOKIE } from "@/lib/exomem-hosted/sessions";
import { refreshExomemThemeSnapshot } from "@/lib/exomem-hosted/theme-snapshot";

export async function proxy(req: NextRequest): Promise<NextResponse> {
  if (req.nextUrl.pathname.startsWith("/tidewave")) {
    return NextResponse.rewrite(new URL("/api/tidewave", req.url));
  }
  const response = NextResponse.next();
  // Exomem HTML routes have no file extension; assets never need an account read. The product
  // site's public root pages are left out: the matcher below cannot name a configured host, and
  // those pages read the last snapshot, which every signed-in visit to an app page refreshes.
  if (
    req.method === "GET" &&
    isExomemPath(req.nextUrl.pathname, req.nextUrl.hostname === productSiteHost()) &&
    !extname(req.nextUrl.pathname) &&
    (!req.headers.has("sec-fetch-dest") || req.headers.get("sec-fetch-dest") === "document") &&
    req.headers.get("accept")?.includes("text/html") &&
    req.headers.get("purpose") !== "prefetch" &&
    !req.headers
      .get("sec-purpose")
      ?.split(";")
      .some((part) => part.trim() === "prefetch") &&
    !req.headers.has("next-router-prefetch") &&
    !req.headers.has("x-middleware-prefetch") &&
    !req.headers.has("rsc")
  ) {
    const csrf = req.cookies.get(EXOMEM_CSRF_COOKIE)?.value ?? null;
    await refreshExomemThemeSnapshot(
      response,
      req.cookies.get(EXOMEM_SESSION_COOKIE)?.value ?? null,
      csrf,
      req.cookies.get(exomemThemeCookieName(themeBindingFromCsrfToken(csrf ?? "")))?.value
    );
  }
  return response;
}

// Without a matcher the proxy runs as a billed function on every request, assets and
// bots included. Next.js reads this at build time, so it must stay an inline literal. It
// only narrows which requests start the proxy; the checks above still decide. A path with
// a dot anywhere under /exomem is treated as a file, which is stricter than the extension
// check above; no Exomem page has a dotted segment. `missing` keeps client navigations and
// prefetches, which those checks skip, from starting it. The second source repeats
// PRODUCT_APP_PAGES (product-pages.ts) because a literal cannot import it; the proxy matcher
// test fails when a page is missing here. Those root paths are app pages on the product site.
export const config = {
  matcher: [
    "/tidewave/:path*",
    {
      source: "/exomem/:path((?!.*\\.).*)?",
      missing: [
        { type: "header", key: "rsc" },
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    {
      source:
        "/:page(access-log|authorize|delete|design-system|email-change|email-preview|home|invite|operator|setup|sign-in|unsubscribe|viewer)/:path((?!.*\\.).*)?",
      missing: [
        { type: "header", key: "rsc" },
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
