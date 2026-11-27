import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { renderCheckoutPage } from "./render-checkout-page";

// A separate file: Paddle's loader caches its result for the life of the module, and this case
// needs a load that fails while the other file needs one that works.
const transactionId = "txn_01234567890123456789012345";
const originalToken = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
before(() => {
  delete process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
});
after(() => {
  if (originalToken !== undefined) process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN = originalToken;
});

it("says the checkout did not open, and links back to the same transaction, when Paddle cannot load", async () => {
  const consoleError = console.error;
  console.error = () => {};
  const close = await renderCheckoutPage(`_ptxn=${transactionId}`);
  console.error = consoleError;
  try {
    const main = document.querySelector("main")!;
    assert.match(main.textContent ?? "", /The checkout did not open\./);
    assert.doesNotMatch(main.textContent ?? "", /Opening your checkout/);
    assert.equal(main.querySelector("a")?.getAttribute("href"), `/checkout?_ptxn=${transactionId}`);
  } finally {
    await close();
  }
});
