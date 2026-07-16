import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act, Fragment, type ReactNode } from "react";
import type { Root } from "react-dom/client";

const componentUrls = ["Hook.tsx", "Philosophy.tsx", "Products.tsx"].map(
  (file) => pathToFileURL(resolve(process.cwd(), "src/components", file)).href
);

function renderServerHtml(): string {
  const script = `
    const React = (await import("react")).default;
    const { renderToString } = await import("react-dom/server");
    const component = (module) => typeof module.default === "function" ? module.default : module.default.default;
    const Hook = component(await import(${JSON.stringify(componentUrls[0])}));
    const Philosophy = component(await import(${JSON.stringify(componentUrls[1])}));
    const Products = component(await import(${JSON.stringify(componentUrls[2])}));
    const page = React.createElement(
      React.Fragment,
      null,
      React.createElement(Hook),
      React.createElement(Philosophy),
      React.createElement(Products)
    );
    process.stdout.write(renderToString(page));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function installDom(serverHtml: string, reducedMotion: boolean) {
  const dom = new JSDOM(
    `<!doctype html><html><body><main id="mount">${serverHtml}</main></body></html>`,
    {
      pretendToBeVisual: true,
      url: "https://substratesystems.io/",
    }
  );
  const window = dom.window;
  const motionQuery = {
    matches: reducedMotion,
    media: reducedMotion
      ? "(prefers-reduced-motion: reduce)"
      : "(prefers-reduced-motion: no-preference)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  } as MediaQueryList;

  window.matchMedia = (() => motionQuery) as typeof window.matchMedia;
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 0);
  window.cancelAnimationFrame = (handle: number) => window.clearTimeout(handle);

  const observers: TestIntersectionObserver[] = [];
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    readonly elements = new Set<Element>();

    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.push(this);
    }

    disconnect() {
      this.elements.clear();
    }
    observe(element: Element) {
      this.elements.add(element);
    }
    takeRecords() {
      return [];
    }
    unobserve(element: Element) {
      this.elements.delete(element);
    }
    trigger() {
      const entries = Array.from(this.elements, (target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      })) as IntersectionObserverEntry[];
      if (entries.length) this.callback(entries, this);
      return entries.length;
    }
  }

  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    IntersectionObserver: TestIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }

  return {
    dom,
    triggerIntersections: () =>
      observers.reduce((count, observer) => count + observer.trigger(), 0),
  };
}

function assertFinalStaticStyle(element: HTMLElement, label: string) {
  const style = getComputedStyle(element);
  assert.ok(style.opacity === "" || style.opacity === "1", `${label} should be fully opaque`);
  assert.doesNotMatch(style.transform, /translate|scale/, `${label} should not transform`);
  assert.doesNotMatch(style.clipPath, /inset\(100%/, `${label} should not be clipped`);
}

function assertConnectedSpine(stage: string) {
  const hookSection = document.getElementById("content");
  const hookConnector = document.querySelector('[data-narrative-connector-base="hook"]');
  assert.ok(hookSection);
  assert.ok(hookConnector instanceof HTMLElement, `${stage} Hook connector should exist`);
  assertFinalStaticStyle(hookConnector, `${stage} Hook connector`);
  assert.doesNotMatch(hookConnector.className, /origin-top/);
  assert.ok(
    hookConnector.querySelector('[data-narrative-connector-signal="hook"]'),
    `${stage} Hook signal should be layered inside the base`
  );
  assert.equal(
    hookConnector.parentElement?.lastElementChild,
    hookConnector,
    `${stage} Hook connector should reach the section boundary`
  );
  assert.match(hookConnector.parentElement?.className ?? "", /max-w-3xl/);

  const philosophyConnector = document.querySelector(
    '[data-narrative-connector-base="philosophy"]'
  );
  assert.ok(
    philosophyConnector instanceof HTMLElement,
    `${stage} Philosophy boundary connector should exist`
  );
  assertFinalStaticStyle(philosophyConnector, `${stage} Philosophy boundary connector`);
  assert.doesNotMatch(philosophyConnector.className, /origin-top/);
  assert.ok(
    philosophyConnector.querySelector('[data-narrative-connector-signal="philosophy"]'),
    `${stage} Philosophy signal should be layered inside the base`
  );
  assert.match(philosophyConnector.className, /top-0/);
  assert.match(philosophyConnector.closest("div.mx-auto")?.className ?? "", /max-w-3xl/);
  assert.match(philosophyConnector.parentElement?.querySelector("ol")?.className ?? "", /pt-32/);
}

function assertCompleteStaticNarrative(stage: string) {
  const hookReveal = document.querySelector("#content .overflow-hidden > div");
  assert.ok(hookReveal instanceof HTMLElement);
  assertFinalStaticStyle(hookReveal, `${stage} thesis`);

  const philosophyList = document.querySelector("ol");
  assert.ok(philosophyList);
  assert.deepEqual(
    Array.from(philosophyList.children, (item) => item.textContent?.trim()),
    [
      "Your setup should survive the machine.",
      "Your memory should outlive the session.",
      "Your AI should show its sources.",
    ]
  );

  const philosophySection = philosophyList.closest("section");
  const spine = philosophySection?.querySelector('[data-narrative-connector-base="philosophy"]');
  assert.ok(spine instanceof HTMLElement);
  assertFinalStaticStyle(spine, `${stage} philosophy spine`);
  philosophyList.querySelectorAll("p").forEach((statement, index) => {
    assertFinalStaticStyle(statement, `${stage} philosophy statement ${index + 1}`);
  });

  const productsHeading = Array.from(document.querySelectorAll("h2")).find(
    (heading) => heading.textContent?.trim() === "Products"
  );
  const productLinks = productsHeading?.closest("section")?.querySelectorAll("a") ?? [];
  assert.deepEqual(
    Array.from(productLinks, (link) => link.querySelector("h3")?.textContent?.trim()),
    ["Q", "Endstate", "Exomem"]
  );
  productLinks.forEach((link, index) => {
    link
      .querySelectorAll<HTMLElement>("h3, p, div > span")
      .forEach((element) =>
        assertFinalStaticStyle(element, `${stage} product ${index + 1} content`)
      );
  });
}

describe("landing narrative reduced motion hydration", () => {
  it("keeps normal-motion SSR content visible without JavaScript", () => {
    const { dom } = installDom(renderServerHtml(), false);

    try {
      assertCompleteStaticNarrative("normal-motion no-JS");
      assertConnectedSpine("normal-motion no-JS");
    } finally {
      dom.window.close();
    }
  });

  it("hydrates the complete static narrative with its semantic order intact", async () => {
    const serverHtml = renderServerHtml();
    const { dom, triggerIntersections } = installDom(serverHtml, true);
    const mount = document.getElementById("mount");
    assert.ok(mount);
    assertCompleteStaticNarrative("server-rendered");
    assertConnectedSpine("server-rendered");

    const hydrationErrors: string[] = [];
    const motionWarnings: string[] = [];
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;
    console.error = (...args: unknown[]) => hydrationErrors.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => motionWarnings.push(args.map(String).join(" "));
    let root: Root | undefined;

    try {
      const [reactDomClient, { default: Hook }, { default: Philosophy }, { default: Products }] =
        await Promise.all([
          import("react-dom/client"),
          import("../Hook"),
          import("../Philosophy"),
          import("../Products"),
        ]);
      const { hydrateRoot } = reactDomClient.default as unknown as {
        hydrateRoot: (container: Element | Document, children: ReactNode) => Root;
      };

      await act(async () => {
        root = hydrateRoot(
          mount,
          <Fragment>
            <Hook />
            <Philosophy />
            <Products />
          </Fragment>
        );
        await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(undefined)));
      });

      assertCompleteStaticNarrative("hydrated");
      assertConnectedSpine("hydrated");

      await act(async () => {
        assert.ok(triggerIntersections() > 0, "the harness should trigger observed motion targets");
        await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(undefined)));
      });
      assertConnectedSpine("intersection-triggered");

      assert.equal(
        hydrationErrors.filter((message) => /hydration|did not match/i.test(message)).length,
        0,
        hydrationErrors.join("\n")
      );
      assert.equal(
        motionWarnings.filter((message) => !/Reduced Motion enabled/i.test(message)).length,
        0,
        motionWarnings.join("\n")
      );
    } finally {
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
      if (root) await act(async () => root?.unmount());
      dom.window.close();
    }
  });
});
