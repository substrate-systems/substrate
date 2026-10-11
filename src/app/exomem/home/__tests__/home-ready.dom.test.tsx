import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";

// A Cloud tenant's Home may call only the routes that work for a Cloud tenant.
// Capture, search, overview, upload and export called routes that reach only
// the retired Hosted cells, so they failed for every Cloud tenant.
const CLOUD_ROUTES = [
  "/api/exomem/status",
  "/api/exomem/account",
  "/api/exomem/billing/",
  "/api/exomem/deletion/",
  "/api/exomem/access/logout",
];

function installDom(): void {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>', {
    pretendToBeVisual: true,
    url: "https://substratesystems.io/exomem/home",
  });
  const win = dom.window;
  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    location: win.location,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    getComputedStyle: win.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
}

describe("a ready Cloud tenant's Home", () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];

  before(() => {
    mock.module("../../private-shell.module.css", { defaultExport: {} });
    installDom();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      if (url === "/api/exomem/status") {
        return Response.json({
          status: { state: "ready", code: "READY", retryable: false },
          cloudConnectorUrl: "https://cloud.example.test/mcp/v1",
        });
      }
      if (url === "/api/exomem/account") {
        return Response.json({
          billing: {
            source: "paddle",
            state: "active",
            checkoutAvailable: false,
            portalAvailable: true,
          },
        });
      }
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    mock.reset();
  });

  it("offers connect, billing and deletion, and calls only Cloud routes", async () => {
    const { default: ExomemHomePage } = await import("../page");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(document.getElementById("mount")!);
    await act(async () => root.render(await ExomemHomePage()));
    const home = () => document.querySelector('section[aria-labelledby="home-title"]');
    for (
      let attempt = 0;
      attempt < 50 && !home()?.textContent?.includes("Manage billing");
      attempt += 1
    ) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    const text = home()?.textContent ?? "";
    const forms = document.querySelectorAll("form").length;
    for (const button of Array.from(document.querySelectorAll("button"))) {
      await act(async () => button.click());
    }
    await act(async () => root.unmount());

    assert.match(text, /https:\/\/cloud\.example\.test\/mcp\/v1/);
    assert.match(text, /Manage billing/);
    assert.match(text, /Delete Exomem/);
    assert.equal(forms, 0);
    assert.deepEqual(
      requested.filter((url) => !CLOUD_ROUTES.some((prefix) => url.startsWith(prefix))),
      []
    );
  });
});
