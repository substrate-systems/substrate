import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { runInNewContext } from "node:vm";
import { CookieJar } from "jsdom";
import { NextResponse } from "next/server";
import { digestSecret } from "../security";
import type { ExomemSessionRow } from "../db";
import { exomemThemeScript } from "@/lib/exomem/theme-script.generated";
import {
  EXOMEM_THEME_COOKIE_PREFIX,
  exomemThemeCookieName,
  themeBindingFromCsrfToken,
} from "@/lib/exomem/theme-binding";

let lookup: () => Promise<ExomemSessionRow | null>;
before(() =>
  mock.module("../db", {
    namedExports: {
      findExomemSessionByDigest: () => lookup(),
      revokeExomemSession: async () => {},
      rotateExomemSessionAtomic: async () => null,
    },
  })
);
after(() => mock.reset());

const expiresAt = "2030-01-01T00:00:00.000Z";
const token = Buffer.alloc(32, 1).toString("base64url");
function session(csrf: string, choice: "dark" | "light"): ExomemSessionRow {
  return {
    id: csrf,
    userId: csrf,
    tenantId: csrf,
    csrfDigest: digestSecret(csrf),
    expiresAt,
    themeChoice: choice,
    emailScheme: choice,
  };
}
function applyResponse(jar: CookieJar, response: NextResponse): void {
  for (const cookie of response.headers.getSetCookie())
    jar.setCookieSync(cookie, "https://example.test/");
}
function firstTheme(jar: CookieJar): string | undefined {
  const attrs = new Map<string, string>();
  runInNewContext(exomemThemeScript, {
    TextEncoder,
    location: { pathname: "/exomem/home" },
    document: {
      cookie: jar.getCookieStringSync("https://example.test/"),
      documentElement: {
        getAttribute: (name: string) => attrs.get(name) ?? null,
        setAttribute: (name: string, value: string) => attrs.set(name, value),
      },
    },
    window: {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      matchMedia: () => ({ matches: false }),
    },
  });
  return attrs.get("data-theme");
}

describe("theme snapshots cannot cross an authentication response", () => {
  it("keeps the new account's first theme when held old HTML arrives after sign-in, then clears scope on logout", async () => {
    const { refreshExomemThemeSnapshot } = await import("../theme-snapshot");
    const { applySessionCookies, clearSessionCookies } = await import("../sessions");
    const jar = new CookieJar();
    let releaseOld!: (value: ExomemSessionRow) => void;
    lookup = () =>
      new Promise((resolve) => {
        releaseOld = resolve;
      });
    const oldHtml = NextResponse.next();
    const oldRead = refreshExomemThemeSnapshot(oldHtml, token, "csrf-a");
    lookup = async () => session("csrf-b", "light");
    const signIn = NextResponse.json({ success: true });
    await applySessionCookies(
      signIn,
      { sessionToken: token, csrfToken: "csrf-b", expiresAt: new Date(expiresAt) },
      new Request("https://example.test/exomem", {
        headers: { cookie: `${exomemThemeCookieName(themeBindingFromCsrfToken("csrf-a"))}=old` },
      })
    );
    applyResponse(jar, signIn);
    releaseOld(session("csrf-a", "dark"));
    await oldRead;
    assert.deepEqual(
      oldHtml.cookies.getAll().map((cookie) => cookie.name),
      [exomemThemeCookieName(themeBindingFromCsrfToken("csrf-a"))]
    );
    applyResponse(jar, oldHtml);
    assert.equal(firstTheme(jar), "light");
    const current = jar
      .getCookiesSync("https://example.test/")
      .find((cookie) => cookie.key === exomemThemeCookieName(themeBindingFromCsrfToken("csrf-b")));
    assert.equal(current?.expires.toString(), new Date(expiresAt).toString());

    const logout = NextResponse.json({ success: true });
    clearSessionCookies(
      logout,
      new Request("https://example.test/exomem", {
        headers: { cookie: jar.getCookieStringSync("https://example.test/") },
      })
    );
    applyResponse(jar, logout);
    assert.equal(firstTheme(jar), "dark");
    assert.equal(
      jar
        .getCookiesSync("https://example.test/")
        .some((cookie) => cookie.key.startsWith(EXOMEM_THEME_COOKIE_PREFIX)),
      false
    );
  });

  it("uses cached state only for the current binding when the optional read fails", async () => {
    const { accountThemeSnapshot, refreshExomemThemeSnapshot } = await import("../theme-snapshot");
    lookup = async () => {
      throw new Error("unavailable");
    };
    for (const csrf of ["csrf-a", "csrf-b"]) {
      const response = NextResponse.next();
      await refreshExomemThemeSnapshot(
        response,
        token,
        "csrf-a",
        JSON.stringify(accountThemeSnapshot(session(csrf, "light")))
      );
      const value = JSON.parse(
        response.cookies.get(exomemThemeCookieName(themeBindingFromCsrfToken("csrf-a")))!.value
      );
      assert.equal(value.choice, csrf === "csrf-a" ? "light" : "auto");
      assert.equal(response.cookies.getAll().length, 1);
    }
  });
});
