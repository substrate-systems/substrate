import assert from "node:assert/strict";
import { after, before, beforeEach, it, mock } from "node:test";
import { renderCheckoutPage } from "./render-checkout-page";
import type { CheckoutOpenOptions } from "@paddle/paddle-js";

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

it("opens the Paddle checkout for the returned transaction and names no product", async () => {
  const close = await renderCheckoutPage(`_ptxn=${transactionId}`);
  try {
    assert.equal(opened.length, 1);
    assert.equal(opened[0].transactionId, transactionId);
    assert.equal(document.querySelector("main")?.textContent, "CheckoutOpening your checkout…");
    assert.equal(document.querySelector("main a"), null);
  } finally {
    await close();
  }
});

it("offers the home page, and opens nothing, when no transaction is passed", async () => {
  for (const query of ["", "_ptxn=not-a-transaction"]) {
    const close = await renderCheckoutPage(query);
    try {
      assert.equal(opened.length, 0, query);
      assert.equal(document.querySelector("main a")?.getAttribute("href"), "/", query);
    } finally {
      await close();
    }
  }
});

it("asks search engines not to index the page", async () => {
  const { metadata } = await import("./page");
  assert.deepEqual(metadata.robots, { index: false, follow: true });
});
