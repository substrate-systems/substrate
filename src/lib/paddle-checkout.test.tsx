import assert from "node:assert/strict";
import { after, before, beforeEach, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { CheckoutOpenOptions } from "@paddle/paddle-js";
import type { UsePaddleResult } from "./paddle";

const transactionId = "txn_01234567890123456789012345";
const opened: CheckoutOpenOptions[] = [];
const originalToken = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
before(() => {
  process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = "test_isolated_checkout";
  mock.module("@paddle/paddle-js", {
    namedExports: {
      CheckoutEventNames: { CHECKOUT_COMPLETED: "checkout.completed" },
      initializePaddle: async () => ({
        Checkout: { open: (options: CheckoutOpenOptions) => opened.push(options) },
      }),
    },
  });
});
beforeEach(() => {
  opened.length = 0;
});
after(() => {
  mock.reset();
  if (originalToken === undefined) delete process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  else process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = originalToken;
});

async function render(
  component: Parameters<typeof createElement>[0],
  url = "http://localhost/exomem/setup"
) {
  const dom = new JSDOM(
    '<!doctype html><html data-exomem data-theme="light"><body><div id="mount"></div></body></html>',
    { url }
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(createElement(component)));
  return async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

it("prefills the authenticated journey email without replacing the server's transaction", async () => {
  const { useCheckout } = await import("@/app/exomem/_journey/account-actions");
  let checkout!: ReturnType<typeof useCheckout>;
  function Subscribe() {
    checkout = useCheckout(() => {}, "owner@example.invalid");
    return null;
  }
  const close = await render(Subscribe);
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          checkoutUrl: `https://checkout.example.invalid/?_ptxn=${transactionId}`,
        })
      )
  );
  try {
    await act(async () => checkout.subscribe());
    assert.equal(opened.length, 1);
    assert.equal(opened[0].transactionId, transactionId);
    assert.deepEqual(opened[0].customer, { email: "owner@example.invalid" });
    assert.equal(opened[0].items, undefined);
    assert.equal(opened[0].customData, undefined);
    assert.deepEqual(opened[0].settings, { displayMode: "overlay", theme: "light" });
  } finally {
    fetchMock.mock.restore();
    await close();
  }
});

it("validates a returned owner checkout, prefills its email and removes the return credential", async () => {
  const { PaddleTransactionOpener } = await import("@/components/PaddleTransactionOpener");
  let validatedTransaction: unknown;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      validatedTransaction = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          success: true,
          checkoutUrl: `https://checkout.example.invalid/?_ptxn=${transactionId}`,
        })
      );
    }
  );
  function ReturnedCheckout() {
    return (
      <PaddleTransactionOpener
        validationEndpoint="/api/exomem/billing/checkout"
        customerEmail="returning@example.invalid"
      />
    );
  }
  const close = await render(
    ReturnedCheckout,
    `http://localhost/exomem/home?_ptxn=${transactionId}`
  );
  try {
    assert.deepEqual(validatedTransaction, { transactionId });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].transactionId, transactionId);
    assert.deepEqual(opened[0].customer, { email: "returning@example.invalid" });
    assert.equal(new URL(window.location.href).searchParams.has("_ptxn"), false);
  } finally {
    fetchMock.mock.restore();
    await close();
  }
});

it("keeps transaction checkout available when the caller has no account email", async () => {
  const { usePaddle } = await import("./paddle");
  let paddle!: UsePaddleResult;
  function GenericCheckout() {
    paddle = usePaddle("transaction");
    return null;
  }
  const close = await render(GenericCheckout);
  try {
    assert.equal(await paddle.openTransactionCheckout(transactionId, null), true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].customer, undefined);
    assert.equal(opened[0].transactionId, transactionId);
  } finally {
    await close();
  }
});

it("validates and opens a returned checkout when the optional account email never arrives", async () => {
  const { PaddleTransactionOpener } = await import("@/components/PaddleTransactionOpener");
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          checkoutUrl: `https://checkout.example.invalid/?_ptxn=${transactionId}`,
        })
      )
  );
  function ReturnedCheckout() {
    return (
      <PaddleTransactionOpener
        validationEndpoint="/api/exomem/billing/checkout"
        customerEmailPending
      />
    );
  }
  const close = await render(
    ReturnedCheckout,
    `http://localhost/exomem/home?_ptxn=${transactionId}`
  );
  try {
    assert.equal(new URL(window.location.href).searchParams.has("_ptxn"), false);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(opened.length, 0);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 2_100)));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].transactionId, transactionId);
    assert.equal(opened[0].customer, undefined);
  } finally {
    fetchMock.mock.restore();
    await close();
  }
});
