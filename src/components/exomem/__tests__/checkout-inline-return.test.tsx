import assert from "node:assert/strict";
import { after, before, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";

// The checkout's own logic runs for real. Its stylesheets, its drawn children and the
// browser's network and Paddle are stood in for, since this runner loads no CSS.
let answerCheck: (result: Record<string, unknown>) => void = () => {};
before(() => {
  mock.module("../CheckoutInline.module.css", { defaultExport: {} });
  mock.module("../Transitions.module.css", { defaultExport: {} });
  mock.module("../Button", {
    namedExports: {
      Button: ({
        children,
        onClick,
        disabled,
        ref,
      }: {
        children: ReactNode;
        onClick?: () => void;
        disabled?: boolean;
        ref?: Ref<HTMLButtonElement>;
      }) => createElement("button", { ref, onClick, disabled }, children),
    },
  });
  for (const [path, name] of [
    ["../FlowField", "FlowField"],
    ["../Mark", "Mark"],
    ["../Wordmark", "Wordmark"],
    ["../ThemeToggle", "ThemeToggle"],
  ])
    mock.module(path, { namedExports: { [name]: () => null } });
  mock.module("../../PaddleTransactionOpener", {
    namedExports: { PENDING_TRANSACTION_KEY: "exomem-pending-transaction" },
  });
  mock.module("@paddle/paddle-js", {
    namedExports: {
      CheckoutEventNames: {
        CHECKOUT_LOADED: "checkout.loaded",
        CHECKOUT_COMPLETED: "checkout.completed",
      },
    },
  });
  mock.module("../../../lib/paddle", {
    namedExports: { openInlineTransactionCheckout: async () => null },
  });
  mock.module("../../../lib/exomem-hosted/hosted-browser", {
    namedExports: {
      HostedBrowserError: class extends Error {
        status = 0;
      },
      // Account and status reads never answer; only the checkout check matters here.
      getPrivateJson: () => new Promise(() => {}),
      postPrivateJson: (path: string) =>
        path === "/api/exomem/billing/checkout"
          ? new Promise((resolve) => (answerCheck = resolve))
          : new Promise(() => {}),
    },
  });
});
after(() => mock.reset());

it("keeps a returned payment possible when its check outlasts the deadline", async () => {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', {
    url: "http://localhost/exomem/setup?_ptxn=txn_returned",
  });
  const timers: { run: () => void; ms: number }[] = [];
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (run: () => void, ms: number) => timers.push({ run, ms }),
    clearTimeout: () => {},
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { CheckoutInline } = await import("../CheckoutInline");
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () =>
      root.render(
        createElement(CheckoutInline, {
          email: "owner@example.test",
          tenantId: "tenant-1",
          onReady: () => {},
          exportOffered: true,
          returnedTransactionId: "txn_returned",
        })
      )
    );
    // The server check has not answered when the 15 s deadline passes.
    await act(async () => timers.find((timer) => timer.ms === 15_000)!.run());
    const text = document.body.textContent ?? "";
    assert.match(text, /We couldn’t check this checkout/);
    assert.match(text, /Your payment may have reached Paddle/);
    assert.doesNotMatch(text, /Nothing was charged/);

    // The late answer says the payment settled: the checkout shows it as paid.
    await act(async () => answerCheck({ state: "settled" }));
    assert.match(document.body.textContent ?? "", /You’re subscribed/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
