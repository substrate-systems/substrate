import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { applyExomemTheme, setExomemThemeChoice, exomemThemeSaveState } from "../theme";
import { JSDOM } from "jsdom";
import { exomemThemeScript } from "../theme-script.generated";
import { exomemThemeCookieName, themeBindingFromCsrfToken } from "../theme-binding";

// The inline script runs before React, on every page of the site, in whatever
// browser the visitor has. These run the exact string the root layout ships.
function runBeforePaint(
  pathname: string,
  getItem: (key: string) => string | null,
  device: "dark" | "light" = "dark",
  cookie = ""
) {
  const attributes = new Map<string, string>();
  const documentElement = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const window = {
    localStorage: { getItem, setItem: () => {}, removeItem: () => {} },
    matchMedia: (query: string) => ({ matches: query === `(prefers-color-scheme: ${device})` }),
  };
  runInNewContext(exomemThemeScript, {
    TextEncoder,
    location: { pathname },
    window,
    document: { documentElement, cookie },
  });
  return attributes;
}

describe("the theme is applied before first paint", () => {
  it("marks an Exomem page with the stored light theme", () => {
    const attributes = runBeforePaint("/exomem/home", (key) =>
      key === "exomem-theme" ? "light" : null
    );

    assert.equal(attributes.get("data-theme"), "light");
    assert.equal(attributes.has("data-exomem"), true);
  });

  it("follows the device until the person picks a theme", () => {
    assert.equal(runBeforePaint("/exomem", () => null, "light").get("data-theme"), "light");
    assert.equal(runBeforePaint("/exomem", () => null, "dark").get("data-theme"), "dark");
    // A stored dark wins over a light device, as a stored light wins over a dark one above.
    const storedDark = (key: string) => (key === "exomem-theme" ? "dark" : null);
    assert.equal(runBeforePaint("/exomem", storedDark, "light").get("data-theme"), "dark");
  });

  it("falls back to dark when storage is blocked, rather than breaking the page", () => {
    // Private windows and locked-down browsers throw on any storage access.
    const attributes = runBeforePaint("/exomem", () => {
      throw new Error("SecurityError");
    });

    assert.equal(attributes.get("data-theme"), "dark");
  });

  it("leaves the rest of the site untouched", () => {
    // The marker restyles the page ground and scrollbar; outside /exomem it must not appear,
    // including on a path that only starts with the same letters.
    for (const pathname of ["/", "/blog/exomem-vs-claude-mem", "/exomemx"]) {
      assert.equal(runBeforePaint(pathname, () => "light").size, 0, pathname);
    }
  });
});

describe("account-scoped theme before paint", () => {
  it("uses the account's explicit choice before a different browser choice", () => {
    const snapshot = encodeURIComponent(
      JSON.stringify({
        scope: "account-a",
        binding: themeBindingFromCsrfToken("session-a"),
        expiresAt: "2030-01-01T00:00:00Z",
        choice: "dark",
        effective: "dark",
      })
    );
    const attributes = runBeforePaint(
      "/exomem/home",
      () => "light",
      "light",
      `exomem_csrf=session-a; ${exomemThemeCookieName(themeBindingFromCsrfToken("session-a"))}=${snapshot}`
    );
    assert.equal(attributes.get("data-theme"), "dark");
    assert.equal(attributes.get("data-theme-choice"), "dark");
  });
  it("follows the device for account Auto despite another account's browser cache", () => {
    const snapshot = encodeURIComponent(
      JSON.stringify({
        scope: "account-b",
        binding: themeBindingFromCsrfToken("session-b"),
        expiresAt: "2030-01-01T00:00:00Z",
        choice: "auto",
        effective: "dark",
      })
    );
    const attributes = runBeforePaint(
      "/exomem/home",
      () => "dark",
      "light",
      `exomem_csrf=session-b; ${exomemThemeCookieName(themeBindingFromCsrfToken("session-b"))}=${snapshot}`
    );
    assert.equal(attributes.get("data-theme"), "light");
    assert.equal(attributes.get("data-theme-choice"), "auto");
  });
});

function themeBrowser() {
  const dom = new JSDOM("", { url: "https://example.test/exomem/home" });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false }) });
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    Event: globalThis.Event,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    Event: dom.window.Event,
  });
  return {
    root: dom.window.document.documentElement,
    restore: () => {
      Object.assign(globalThis, prior);
      dom.window.close();
    },
  };
}

function accountCookie(scope: string, choice: "auto" | "light" | "dark") {
  document.cookie = `exomem_csrf=${scope}; Path=/`;
  document.cookie = `${exomemThemeCookieName(themeBindingFromCsrfToken(scope))}=${encodeURIComponent(JSON.stringify({ scope, binding: themeBindingFromCsrfToken(scope), choice, effective: choice === "auto" ? "dark" : choice, expiresAt: "2030-01-01T00:00:00Z" }))}; Path=/`;
}

describe("theme saves follow the current account and latest intent", () => {
  it("serializes rapid picks and saves the latest choice without repainting an earlier response", async (context) => {
    const browser = themeBrowser();
    try {
      accountCookie("account-a", "auto");
      applyExomemTheme(browser.root);
      const requests: Array<{ choice: string; finish: (response: Response) => void }> = [];
      context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return new Promise<Response>((finish) =>
          requests.push({ choice: body.themeChoice, finish })
        );
      });
      const first = setExomemThemeChoice(browser.root, "light");
      const latest = setExomemThemeChoice(browser.root, "dark");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        requests.map((request) => request.choice),
        ["light"]
      );
      requests[0]!.finish(
        Response.json({
          success: true,
          themeChoice: "light",
          themeSnapshot: {
            scope: "account-a",
            binding: themeBindingFromCsrfToken("account-a"),
            expiresAt: "2030-01-01T00:00:00Z",
            choice: "light",
            effective: "light",
          },
        })
      );
      await first;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        requests.map((request) => request.choice),
        ["light", "dark"]
      );
      assert.equal(browser.root.getAttribute("data-theme"), "dark");
      assert.equal(exomemThemeSaveState().status, "saving");
      requests[1]!.finish(
        Response.json({
          success: true,
          themeChoice: "dark",
          themeSnapshot: {
            scope: "account-a",
            binding: themeBindingFromCsrfToken("account-a"),
            expiresAt: "2030-01-01T00:00:00Z",
            choice: "dark",
            effective: "dark",
          },
        })
      );
      assert.equal(await latest, true);
      assert.equal(exomemThemeSaveState().status, "saved");
      assert.equal(
        runBeforePaint("/exomem/home", () => "light", "light", document.cookie).get("data-theme"),
        "dark"
      );
    } finally {
      browser.restore();
    }
  });
  it("ignores a late response after the browser switches accounts", async (context) => {
    const browser = themeBrowser();
    try {
      accountCookie("account-a", "auto");
      applyExomemTheme(browser.root);
      let finish: ((response: Response) => void) | undefined;
      context.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      );
      const save = setExomemThemeChoice(browser.root, "light");
      await new Promise((resolve) => setImmediate(resolve));
      accountCookie("account-b", "dark");
      applyExomemTheme(browser.root);
      const before = {
        cookie: document.cookie,
        cache: window.localStorage.getItem("exomem-theme-account"),
      };
      finish!(
        Response.json({
          success: true,
          themeChoice: "light",
          themeSnapshot: {
            scope: "account-a",
            binding: themeBindingFromCsrfToken("account-a"),
            expiresAt: "2030-01-01T00:00:00Z",
            choice: "light",
            effective: "light",
          },
        })
      );
      assert.equal(await save, false);
      assert.equal(document.cookie, before.cookie);
      assert.equal(window.localStorage.getItem("exomem-theme-account"), before.cache);
      assert.equal(browser.root.getAttribute("data-theme"), "dark");
      assert.equal(exomemThemeSaveState().status, "idle");
    } finally {
      browser.restore();
    }
  });
  it("keeps a failed save visible while a fresh load uses the server's canonical choice", async (context) => {
    const browser = themeBrowser();
    try {
      accountCookie("account-c", "light");
      applyExomemTheme(browser.root);
      context.mock.method(globalThis, "fetch", async () =>
        Response.json({ error: { message: "Try again", code: "UNAVAILABLE" } }, { status: 503 })
      );
      assert.equal(await setExomemThemeChoice(browser.root, "dark"), false);
      assert.equal(exomemThemeSaveState().status, "failed");
      assert.equal(browser.root.getAttribute("data-theme"), "dark");
      assert.equal(
        runBeforePaint("/exomem/home", () => "dark", "dark", document.cookie).get("data-theme"),
        "light"
      );
    } finally {
      browser.restore();
    }
  });
});
