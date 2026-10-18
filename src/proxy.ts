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
