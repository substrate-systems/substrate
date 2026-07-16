/* eslint-disable @typescript-eslint/no-require-imports */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const nodeModule = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = nodeModule._load;
nodeModule._load = (request, parent, isMain) => {
  if (request === "next/image") {
    return {
      __esModule: true,
      default: ({ fill, priority, alt = "", ...props }: Record<string, unknown>) => {
        void fill;
        void priority;
        return (
          // The viewer behavior is under test; Next's optimizer requires a browser runtime.
          // eslint-disable-next-line @next/next/no-img-element
          <img {...props} alt={String(alt)} />
        );
      },
    };
  }
  return originalLoad(request, parent, isMain);
};
const PhotographyGallery = (
  require("../PhotographyGallery") as typeof import("../PhotographyGallery")
).default;
nodeModule._load = originalLoad;

const images = [
  {
    id: "one",
    src: "/one.jpg",
    width: 3000,
    height: 2000,
    alt: "First aurora",
    treatment: "colour" as const,
  },
  {
    id: "two",
    src: "/two.jpg",
    width: 3000,
    height: 2000,
    alt: "Second aurora",
    treatment: "black-and-white" as const,
  },
  {
    id: "three",
    src: "/three.jpg",
    width: 3000,
    height: 2000,
    alt: "Third aurora",
    treatment: "colour" as const,
  },
] as const;

let dom: JSDOM | undefined;
let root: Root | undefined;

function installDom() {
  dom = new JSDOM(
    '<!doctype html><html><body><main id="page-root"><button id="outside">Outside</button><div id="mount"></div></main></body></html>',
    { pretendToBeVisual: true, url: "https://substratesystems.io/photography/iceland-aurora" }
  );

  const window = dom.window;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };

  const mount = window.document.getElementById("mount");
  assert.ok(mount);
  root = createRoot(mount);
  return window;
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

async function keydown(key: string, shiftKey = false) {
  await act(async () => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, shiftKey })
    );
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = undefined;
  dom?.window.close();
  dom = undefined;
});

describe("PhotographyGallery modal interactions", () => {
  it("contains focus, locks the page, navigates within bounds, and restores the opener", async () => {
    installDom();
    await act(async () => root?.render(<PhotographyGallery images={images} />));

    const pageRoot = document.getElementById("page-root") as HTMLElement;
    const outside = document.getElementById("outside") as HTMLButtonElement;
    const opener = document.querySelector(
      'button[aria-label^="Open image 1 of 3"]'
    ) as HTMLButtonElement;
    assert.ok(opener);
    const initialInert = pageRoot.inert;
    opener.focus();
    assert.equal(document.activeElement, opener);

    await click(opener);

    const dialog = document.querySelector('[role="dialog"]');
    const close = document.querySelector(
      'button[aria-label="Close image viewer"]'
    ) as HTMLButtonElement;
    assert.ok(dialog);
    assert.equal(document.activeElement, close);
    assert.equal(document.body.style.overflow, "hidden");
    assert.equal(pageRoot.inert, true);
    assert.equal(pageRoot.getAttribute("aria-hidden"), "true");

    outside.focus();
    assert.equal(document.activeElement, outside);
    await keydown("Tab");
    assert.equal(document.activeElement, close, "Tab from outside the modal returns to its start");

    const next = document.querySelector(
      'button[aria-label="View next image"]'
    ) as HTMLButtonElement;
    await click(next);
    await click(next);
    assert.equal(
      document.getElementById("photography-viewer-status")?.textContent?.trim(),
      "Image 3 of 3"
    );
    assert.equal(next.disabled, true);

    await keydown("Escape");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    assert.equal(pageRoot.inert, initialInert);
    assert.equal(pageRoot.getAttribute("aria-hidden"), null);
    assert.equal(document.activeElement, opener);
  });
});
