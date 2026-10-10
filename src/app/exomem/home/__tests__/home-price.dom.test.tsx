import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const PADDLE_SANDBOX_PRICES = "https://sandbox-api.paddle.com/prices/";

function installDom(): JSDOM {
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
  return dom;
}

function useSandboxPaddle(priceId: string): void {
  process.env.PADDLE_ENVIRONMENT = "sandbox";
  process.env.PADDLE_API_KEY = "pdl_sdbx_apikey_example";
  process.env.EXOMEM_PADDLE_PRODUCT_ID = "pro_exomem_cloud";
  process.env.EXOMEM_PADDLE_PRICE_ID = priceId;
}

// The browser asks for its lifecycle; this account still has to subscribe.
// Paddle answers with whatever `paddlePrice` returns for the configured price.
function stubFetch(paddlePrice: (url: string) => Response): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PADDLE_SANDBOX_PRICES)) return paddlePrice(url);
    if (url === "/api/exomem/status") {
      return Response.json({
        status: { state: "awaiting_payment", code: "PAYMENT_REQUIRED", retryable: false },
      });
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }) as typeof fetch;
}

async function renderSubscribeCard(): Promise<string> {
  const { default: ExomemHomePage } = await import("../page");
  const { createRoot } = await import("react-dom/client");
  const page = await ExomemHomePage();
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(page));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (document.body.textContent?.includes("Subscribe and prepare Exomem")) break;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  const card = document.querySelector('section[aria-labelledby="lifecycle-title"]');
  const text = card?.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

describe("Exomem home subscribe card", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  before(() => {
    mock.module("../../private-shell.module.css", { defaultExport: {} });
    installDom();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    mock.reset();
  });

  it("shows the amount, cadence and tax mode Paddle returns for the configured price", async () => {
    useSandboxPaddle("pri_distinctive_amount");
    stubFetch((url) => {
      assert.equal(url, `${PADDLE_SANDBOX_PRICES}pri_distinctive_amount`);
      return Response.json({
        data: {
          id: "pri_distinctive_amount",
          product_id: "pro_exomem_cloud",
          status: "active",
          tax_mode: "internal",
          billing_cycle: { interval: "month", frequency: 1 },
          unit_price: { amount: "1234", currency_code: "EUR" },
        },
      });
    });

    const card = await renderSubscribeCard();

    assert.match(card, /Subscribe before we prepare your Exomem/);
    assert.match(card, /€12\.34 per month/);
    assert.match(card, /including tax/);
  });

  it("shows no amount and logs the failure when Paddle cannot answer", async () => {
    useSandboxPaddle("pri_paddle_unavailable");
    stubFetch(() => new Response("upstream unavailable", { status: 503 }));
    const logged = mock.method(console, "error", () => undefined);

    const card = await renderSubscribeCard();
    logged.mock.restore();

    assert.match(card, /Cancel through Paddle\./);
    assert.doesNotMatch(card, /\d/, "no price number may appear without Paddle's answer");
    assert.ok(logged.mock.callCount() >= 1, "the Paddle failure is logged server-side");
  });
});
