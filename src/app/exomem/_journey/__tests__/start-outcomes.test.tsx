import assert from "node:assert/strict";
import { after, before, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ReactNode } from "react";
import { EXOMEM_SIGN_IN_EVENT_KEY } from "@/lib/exomem-hosted/hosted-browser";
import { failureCopy, limitedCopy } from "../copy";

// The start flow runs for real against a stubbed /api/exomem/access/start. Stylesheets, the drawn
// field, tiles, wordmark and theme control are stood in for, since this runner loads no CSS.
// Cloudflare's widget is stood in for too: it is not ours, and its token is not the question.
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
  mock.module("../turnstile", {
    namedExports: {
      ChallengeError: class ChallengeError extends Error {},
      useTurnstile: () => ({
        mount: () => {},
        token: async () => "token",
        reset: () => {},
        start: async () => {},
        asking: false,
      }),
    },
  });
});
after(() => mock.reset());

/** Renders the start flow, types an address and submits it; the server answers as `answer`. */
async function submitAddress(answer: { status: number; body: Record<string, unknown> }) {
  const dom = new JSDOM('<!doctype html><div id="mount"></div>', {
    url: "http://localhost/exomem/start",
    // A visible tab, so a check that only polls while visible cannot hide from the test.
    pretendToBeVisual: true,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let sessionChecks = 0;
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string) => {
      if (String(url).endsWith("/api/exomem/access/start"))
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      if (String(url).endsWith("/api/exomem/access/session")) sessionChecks += 1;
      return new Response("{}", { status: 404 });
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  // React DOM reads the browser it runs in when it loads, so it loads after the globals.
  const { createRoot } = await import("react-dom/client");
  const { StartFlow } = await import("../start-flow");
  const root = createRoot(document.getElementById("mount")!);
  await act(async () =>
    root.render(
      createElement(StartFlow, {
        context: { kind: "web" },
        reviewerEnabled: false,
        statusPageUrl: null,
        frame: {},
      })
    )
  );
  const input = document.querySelector<HTMLInputElement>('input[name="email"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "person@example.com"
    );
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector("form")!.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    page: () => document.body.textContent ?? "",
    input: () => document.querySelector('input[name="email"]'),
    focused: () => document.activeElement,
    sessionChecks: () => sessionChecks,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

// A person who fixes a typo inside a minute is refused by the browser limit, not the address
// limit. The page used to tell them "we already emailed this address" when nothing was sent.
for (const limit of ["browser", "ip"] as const) {
  it(`says that nothing was sent, and not that the address was emailed, when the ${limit} limit refused`, async () => {
    const start = await submitAddress({
      status: 202,
      body: {
        success: true,
        status: "if_eligible_email_sent",
        retryAfterSeconds: 59,
        limitedBy: limit,
        retryLimited: true,
      },
    });
    try {
      assert.ok(start.page().includes(limitedCopy.lede[limit]), start.page());
      assert.ok(start.page().includes(limitedCopy.wait("in about 1 minute")), start.page());
      assert.equal(start.page().includes("emailed"), false, start.page());
    } finally {
      await start.close();
    }
  });
}

it("puts the cursor back in the address field when the server cannot use the address", async () => {
  const start = await submitAddress({ status: 400, body: { error: "invalid_email" } });
  try {
    assert.ok(start.page().includes(failureCopy.invalidEmail), start.page());
    assert.equal(start.focused(), start.input());
  } finally {
    await start.close();
  }
});

// A "check your email" tab left open asked the server every 3 seconds, about 21,500 billed
// calls a day. Only a sign-in in this browser moves the tab on, so it asks when the step opens,
// when another tab announces a sign-in, and when the person comes back to it.
it("asks whether the person signed in only on those events, never on a timer", async () => {
  const start = await submitAddress({
    status: 202,
    body: { success: true, status: "if_eligible_email_sent", retryAfterSeconds: 59 },
  });
  const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    await settle();
    assert.equal(start.sessionChecks(), 1, "the step opens with one check");
    await settle(3_200);
    assert.equal(start.sessionChecks(), 1, "no timed check");
    await act(async () => {
      window.dispatchEvent(new window.StorageEvent("storage", { key: EXOMEM_SIGN_IN_EVENT_KEY }));
    });
    await settle();
    assert.equal(start.sessionChecks(), 2, "another tab's sign-in checks at once");
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    await settle();
    assert.equal(start.sessionChecks(), 3, "returning to the tab checks");
  } finally {
    await start.close();
  }
});
