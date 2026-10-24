import assert from "node:assert/strict";
import { after, before, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import { reviewerCopy, startCopy } from "../copy";

// The start flow and its page run for real. Stylesheets and the drawn field, tiles,
// wordmark and theme control are stood in for, since this runner loads no CSS.
before(() => {
  for (const path of [
    "../journey.module.css",
    "../../../../components/exomem/phone.module.css",
    "../../../../components/exomem/Button.module.css",
    "../../../../components/exomem/TextField.module.css",
    "../../../../components/exomem/Notice.module.css",
    "../../../../components/exomem/Transitions.module.css",
    "../../../../components/exomem/SegmentedSwitch.module.css",
  ])
    mock.module(path, { defaultExport: {} });
  for (const [path, name] of [
    ["../../../../components/exomem/FlowField", "FlowField"],
    ["../../../../components/exomem/PairedTiles", "PairedTiles"],
    ["../../../../components/exomem/Wordmark", "Wordmark"],
    ["../../../../components/exomem/ThemeToggle", "ThemeToggle"],
  ])
    mock.module(path, { namedExports: { [name]: () => null } });
  mock.module("next/link", {
    defaultExport: ({ children, href }: { children: ReactNode; href: string }) =>
      createElement("a", { href }, children),
  });
});
after(() => mock.reset());

it("announces every failed reviewer sign-in, not only the first", async () => {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', {
    url: "http://localhost/exomem/start",
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The reviewer route refuses the password every time.
    fetch: async () => new Response("{}", { status: 401 }),
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React DOM reads the browser it runs in when it loads, so it loads after the globals.
  const { createRoot } = await import("react-dom/client");
  const { StartFlow } = await import("../start-flow");
  const root = createRoot(document.getElementById("mount")!);
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const submit = () =>
    act(async () => {
      document.querySelector("form")!.requestSubmit();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  try {
    await act(async () =>
      root.render(
        createElement(StartFlow, {
          context: { kind: "web" },
          reviewerEnabled: true,
          statusPageUrl: null,
          frame: {},
        })
      )
    );
    const link = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === startCopy.reviewerLink
    )!;
    await act(async () => link.click());
    const [username, password] = document.querySelectorAll("input");
    await act(async () => {
      type(username, "reviewer");
      type(password, "wrong");
    });

    const region = document.querySelector('[role="status"]')!;
    const heard: string[] = [];
    new dom.window.MutationObserver(() => heard.push(region.textContent ?? "")).observe(region, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    await submit();
    await submit();
    await act(async () => {});

    const failures = heard.filter((text) => text.includes(reviewerCopy.failedOnWeb));
    assert.equal(failures.length, 2, `the status region was written: ${JSON.stringify(heard)}`);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
