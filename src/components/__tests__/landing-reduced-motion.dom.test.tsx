import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { Root } from "react-dom/client";

const landingUrl = pathToFileURL(
  resolve(process.cwd(), "src/components/LandingNarrative.tsx")
).href;

function renderServerHtml(): string {
  const script = `
    const React = (await import("react")).default;
    const { renderToString } = await import("react-dom/server");
    const mod = await import(${JSON.stringify(landingUrl)});
    const Landing = typeof mod.default === "function" ? mod.default : mod.default.default;
    process.stdout.write(renderToString(React.createElement(Landing)));
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

class MotionQuery implements MediaQueryList {
  readonly media = "(prefers-reduced-motion: reduce)";
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null = null;
  private listeners = new Set<
    | EventListenerOrEventListenerObject
    | ((this: MediaQueryList, event: MediaQueryListEvent) => void)
  >();
  constructor(public matches: boolean) {}
  addEventListener<K extends keyof MediaQueryListEventMap>(
    _type: K,
    listener: (this: MediaQueryList, event: MediaQueryListEventMap[K]) => void,
    _options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
    _options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    _type: string,
    listener:
      | EventListenerOrEventListenerObject
      | ((this: MediaQueryList, event: MediaQueryListEvent) => void)
  ) {
    this.listeners.add(listener);
  }
  removeEventListener<K extends keyof MediaQueryListEventMap>(
    _type: K,
    listener: (this: MediaQueryList, event: MediaQueryListEventMap[K]) => void,
    _options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
    _options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    _type: string,
    listener:
      | EventListenerOrEventListenerObject
      | ((this: MediaQueryList, event: MediaQueryListEvent) => void)
  ) {
    this.listeners.delete(listener);
  }
  addListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) {
    if (listener) this.listeners.add(listener);
  }
  removeListener(listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) {
    if (listener) this.listeners.delete(listener);
  }
  dispatchEvent(event: Event) {
    void event;
    return true;
  }
  setMatches(matches: boolean) {
    this.matches = matches;
    const event = { matches, media: this.media } as MediaQueryListEvent;
    this.listeners.forEach((listener) => {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    });
  }
  get listenerCount() {
    return this.listeners.size;
  }
}

function installDom(serverHtml: string, reduced = false) {
  const dom = new JSDOM(`<!doctype html><body><main id="mount">${serverHtml}</main></body>`, {
    pretendToBeVisual: true,
    url: "https://substratesystems.io/",
  });
  const win = dom.window;
  const motion = new MotionQuery(reduced);
  let zoneTop = 0;
  let rafId = 0;
  let cancelledRafs = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const intersectionObservers: TestIntersectionObserver[] = [];
  let intersectionDisconnects = 0;
  let resizeDisconnects = 0;
  const resizeObservers: TestResizeObserver[] = [];

  Object.defineProperty(win, "innerHeight", { configurable: true, value: 1000 });
  Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute("data-spine-zone") ? 1200 : 0;
    },
  });
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    let top = 0;
    let height = 20;
    if (this.hasAttribute("data-spine-zone")) {
      top = zoneTop;
      height = 1200;
    } else if (this.hasAttribute("data-spine-node")) {
      const index = Number(this.getAttribute("data-spine-node"));
      top = zoneTop + [300, 600, 900][index];
      height = 11;
    } else if (this.hasAttribute("data-reveal")) {
      const targets = Array.from(win.document.querySelectorAll("[data-reveal]"));
      const index = targets.indexOf(this);
      top = index < 2 ? 100 + index * 100 : 1000 + index * 80;
    }
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 100,
      bottom: top + height,
      width: 100,
      height,
      toJSON() {},
    } as DOMRect;
  };

  win.matchMedia = ((query: string) =>
    query.includes("prefers-reduced-motion")
      ? motion
      : ({ ...new MotionQuery(false), media: query } as MediaQueryList)) as typeof win.matchMedia;
  win.requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++rafId;
    frames.set(id, callback);
    return id;
  };
  win.cancelAnimationFrame = (id: number) => {
    if (frames.delete(id)) cancelledRafs += 1;
  };

  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly thresholds = [0.2];
    readonly rootMargin: string;
    readonly elements = new Set<Element>();
    constructor(
      private callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit
    ) {
      this.rootMargin = options?.rootMargin ?? "0px";
      intersectionObservers.push(this);
    }
    observe(element: Element) {
      this.elements.add(element);
    }
    unobserve(element: Element) {
      this.elements.delete(element);
    }
    disconnect() {
      intersectionDisconnects += 1;
      this.elements.clear();
    }
    takeRecords() {
      return [];
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
      this.callback(entries, this);
    }
  }

  class TestResizeObserver implements ResizeObserver {
    private target?: Element;
    constructor(private callback: ResizeObserverCallback) {
      resizeObservers.push(this);
    }
    observe(target: Element) {
      this.target = target;
      this.trigger();
    }
    unobserve() {}
    disconnect() {
      resizeDisconnects += 1;
      this.target = undefined;
    }
    trigger() {
      if (!this.target) return;
      this.callback(
        [
          {
            target: this.target,
            contentRect: this.target.getBoundingClientRect(),
          } as ResizeObserverEntry,
        ],
        this
      );
    }
  }

  const globals = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    SVGElement: win.SVGElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    getComputedStyle: win.getComputedStyle,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    IntersectionObserver: TestIntersectionObserver,
    ResizeObserver: TestResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }

  return {
    dom,
    motion,
    setZoneTop(value: number) {
      zoneTop = value;
    },
    flushFrame(time: number) {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    },
    triggerIntersections() {
      intersectionObservers.forEach((observer) => observer.trigger());
    },
    triggerResizes() {
      resizeObservers.forEach((observer) => observer.trigger());
    },
    stats() {
      return {
        frames: frames.size,
        cancelledRafs,
        intersectionDisconnects,
        resizeDisconnects,
      };
    },
  };
}

function assertStaticDocument(document: Document) {
  const principles = document.querySelector("ol[data-principles]");
  assert.ok(principles);
  assert.deepEqual(
    Array.from(principles.children, (item) => item.querySelector("p")?.textContent),
    [
      "Your AI should show its sources.",
      "Your setup should survive the machine.",
      "Your memory should outlive the session.",
    ]
  );
  assert.match(document.querySelector("[data-thesis]")?.textContent ?? "", /not\u00a0less/);
  assert.equal(document.querySelectorAll("[data-product-row]").length, 3);
  assert.equal(
    document.querySelector('[data-product-row="q"]')?.getAttribute("href"),
    "https://useq.ai"
  );
  assert.equal(document.querySelector('[data-product-row="q"]')?.getAttribute("target"), "_blank");
  assert.equal(
    document.querySelector('[data-product-row="q"]')?.getAttribute("rel"),
    "noopener noreferrer"
  );
  assert.equal(
    document.querySelector('[data-product-row="endstate"]')?.getAttribute("href"),
    "/endstate"
  );
  assert.equal(
    document.querySelector('[data-product-row="exomem"]')?.getAttribute("href"),
    "/exomem"
  );
  assert.equal(
    document.querySelector('[data-product-row="endstate"]')?.getAttribute("target"),
    null
  );
  assert.equal(document.querySelector('[data-product-row="exomem"]')?.getAttribute("target"), null);
  assert.equal(
    document.querySelector("[data-closing-axiom]")?.textContent,
    "Systems precede products."
  );
  assert.ok(document.querySelector("[data-spine-static]"));
  assert.equal(document.querySelector("[data-spine-svg]"), null);
  assert.equal(
    document.querySelector("[data-spine-zone]")?.getAttribute("data-motion-state"),
    null
  );
  document.querySelectorAll("[data-spine-node]").forEach((node) => {
    assert.equal(node.getAttribute("data-active"), "false");
  });
}

describe("Fable landing progressive enhancement", () => {
  it("ships a complete semantic no-JS document with an unfilled static spine", () => {
    const html = renderServerHtml();
    const dom = new JSDOM(html);
    try {
      assertStaticDocument(dom.window.document);
    } finally {
      dom.window.close();
    }
  });

  it("animates three strands, suppresses offscreen writes, and activates nodes both ways", async () => {
    const html = renderServerHtml();
    const harness = installDom(html);
    const mount = document.getElementById("mount");
    assert.ok(mount);
    const reactDom = await import("react-dom/client");
    const landingModule = await import(landingUrl);
    const Landing = landingModule.default;
    let root: Root | undefined;
    try {
      await act(async () => {
        root = reactDom.hydrateRoot(mount, <Landing />);
      });
      await act(async () => harness.flushFrame(1000));

      const zone = document.querySelector("[data-spine-zone]");
      assert.equal(zone?.getAttribute("data-motion-state"), "normal");
      const strands = Array.from(document.querySelectorAll<SVGPathElement>("[data-spine-strand]"));
      assert.equal(strands.length, 3);
      strands.forEach((strand) => {
        assert.match(strand.getAttribute("d") ?? "", /^M 40 0 L/);
        assert.match(strand.getAttribute("d") ?? "", /L 40 1200$/);
      });
      assert.match(
        document.querySelector("[data-spine-tail]")?.getAttribute("d") ?? "",
        /M 40 400 L 40 550/
      );
      assert.equal(document.querySelector("[data-spine-tail]")?.getAttribute("opacity"), "0.5");
      assert.equal(
        getComputedStyle(document.querySelector("[data-spine-tail]") as SVGPathElement).opacity,
        "0.5"
      );
      assert.equal(
        (document.querySelector("[data-spine-bead]") as HTMLElement | null)?.style.opacity,
        "1"
      );
      assert.match(
        (document.querySelector("[data-spine-bead]") as HTMLElement | null)?.style.transform ?? "",
        /translateY\(550(?:\.0)?px\)/
      );
      assert.deepEqual(
        Array.from(document.querySelectorAll("[data-spine-node]"), (node) =>
          node.getAttribute("data-active")
        ),
        ["true", "false", "false"]
      );

      harness.setZoneTop(-500);
      await act(async () => harness.flushFrame(1100));
      assert.deepEqual(
        Array.from(document.querySelectorAll("[data-spine-node]"), (node) =>
          node.getAttribute("data-active")
        ),
        ["true", "true", "true"]
      );
      harness.setZoneTop(400);
      await act(async () => harness.flushFrame(1200));
      assert.deepEqual(
        Array.from(document.querySelectorAll("[data-spine-node]"), (node) =>
          node.getAttribute("data-active")
        ),
        ["false", "false", "false"]
      );

      harness.setZoneTop(600);
      await act(async () => harness.flushFrame(1300));
      assert.equal(
        (document.querySelector("[data-spine-bead]") as HTMLElement | null)?.style.opacity,
        "0"
      );

      harness.setZoneTop(-1000);
      await act(async () => harness.flushFrame(1400));
      assert.equal(
        getComputedStyle(document.querySelector("[data-spine-tail]") as SVGPathElement).opacity,
        "0.5",
        "the resolved bottom tail should remain at authored opacity"
      );
      assert.equal(
        (document.querySelector("[data-spine-bead]") as HTMLElement | null)?.style.opacity,
        "0"
      );

      const before = strands[0].getAttribute("d");
      harness.setZoneTop(1201);
      await act(async () => harness.flushFrame(5000));
      assert.equal(strands[0].getAttribute("d"), before, "offscreen frames must not write paths");
      assert.equal(harness.stats().frames, 0, "offscreen animation should pause its rAF loop");

      harness.setZoneTop(0);
      harness.triggerResizes();
      assert.ok(harness.stats().frames > 0, "ResizeObserver should resume an onscreen spine");
      await act(async () => harness.flushFrame(6000));
      assert.notEqual(strands[0].getAttribute("d"), before);
    } finally {
      if (root) await act(async () => root?.unmount());
      harness.dom.window.close();
    }
  });

  it("reveals only below-fold targets and handles live reduced motion plus cleanup", async () => {
    const html = renderServerHtml();
    const harness = installDom(html);
    const mount = document.getElementById("mount");
    assert.ok(mount);
    const reactDom = await import("react-dom/client");
    const landingModule = await import(landingUrl);
    const Landing = landingModule.default;
    let root: Root | undefined;
    try {
      await act(async () => {
        root = reactDom.hydrateRoot(mount, <Landing />);
      });
      const reveals = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
      assert.notEqual(reveals[0].dataset.revealState, "hidden");
      assert.ok(reveals.some((target) => target.dataset.revealState === "hidden"));
      assert.equal(document.querySelector("footer [data-reveal]"), null);

      await act(async () => harness.triggerIntersections());
      assert.ok(reveals.every((target) => target.dataset.revealState !== "hidden"));

      await act(async () => harness.motion.setMatches(true));
      assert.equal(
        document.querySelector("[data-spine-zone]")?.getAttribute("data-motion-state"),
        "reduced"
      );
      assert.equal(harness.stats().frames, 0);
      assert.ok(reveals.every((target) => target.style.opacity === ""));

      await act(async () => harness.motion.setMatches(false));
      assert.equal(
        document.querySelector("[data-spine-zone]")?.getAttribute("data-motion-state"),
        "normal"
      );
      assert.ok(harness.stats().frames > 0);
    } finally {
      if (root) await act(async () => root?.unmount());
      const stats = harness.stats();
      assert.equal(harness.motion.listenerCount, 0);
      assert.ok(stats.cancelledRafs > 0);
      assert.ok(stats.intersectionDisconnects > 0);
      assert.ok(stats.resizeDisconnects > 0);
      harness.dom.window.close();
    }
  });
});
