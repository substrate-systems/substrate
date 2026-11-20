import { extname } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isExomemPath } from "@/lib/exomem/theme";
import { exomemThemeCookieName, themeBindingFromCsrfToken } from "@/lib/exomem/theme-binding";
import { EXOMEM_SESSION_COOKIE, EXOMEM_CSRF_COOKIE } from "@/lib/exomem-hosted/sessions";
import { refreshExomemThemeSnapshot } from "@/lib/exomem-hosted/theme-snapshot";

export async function proxy(req: NextRequest): Promise<NextResponse> {
  if (req.nextUrl.pathname.startsWith("/tidewave")) {
    return NextResponse.rewrite(new URL("/api/tidewave", req.url));
  }
  const response = NextResponse.next();
  // Exomem HTML routes have no file extension; assets never need an account read.
  if (
    req.method === "GET" &&
    isExomemPath(req.nextUrl.pathname) &&
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
// prefetches, which those checks skip, from starting it.
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
  ],
};
