import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { PricePreviewParams, PricePreviewResponse } from "@paddle/paddle-js";

// Paddle.js arrives from Paddle's CDN as this global. The real loader in
// @paddle/paddle-js finds it and skips the script tag, so no request leaves.
let pricePreview: (params: PricePreviewParams) => Promise<PricePreviewResponse>;

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>', {
    pretendToBeVisual: true,
    url: "https://substratesystems.io/exomem/home",
  });
  const win = dom.window;
  Object.assign(win, {
    PaddleBillingV1: {
      Initialized: false,
      Environment: { set: () => undefined },
      Initialize: () => undefined,
      PricePreview: (params: PricePreviewParams) => pricePreview(params),
    },
  });
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

function configureSandboxCheckout(priceId: string): void {
  Object.assign(process.env, {
    PADDLE_ENVIRONMENT: "sandbox",
    EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem_cloud",
    EXOMEM_PADDLE_PRICE_ID: priceId,
    EXOMEM_PUBLIC_BASE_URL: "https://substratesystems.io",
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_lane_price_client_token",
    NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
  });
}

// The browser asks for its lifecycle; this account still has to subscribe.
function stubLifecycleFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "/api/exomem/status") {
      return Response.json({
        status: { state: "awaiting_payment", code: "PAYMENT_REQUIRED", retryable: false },
      });
    }
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  }) as typeof fetch;
}

async function renderSubscribeCard(settled: (cardText: string) => boolean): Promise<string> {
  const { default: ExomemHomePage } = await import("../page");
  const { createRoot } = await import("react-dom/client");
  const page = await ExomemHomePage();
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(page));
  const cardText = () =>
    document.querySelector('section[aria-labelledby="lifecycle-title"]')?.textContent ?? "";
  for (let attempt = 0; attempt < 50 && !settled(cardText()); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  const text = cardText();
  await act(async () => root.unmount());
  return text;
}

describe("Exomem home subscribe card", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  before(() => {
    mock.module("../../private-shell.module.css", { defaultExport: {} });
    installDom();
    stubLifecycleFetch();
  });

  after(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    mock.reset();
  });

  it("shows the total, cadence and tax that Paddle.js previews for the configured price", async () => {
    configureSandboxCheckout("pri_distinctive_amount");
    const previewed: PricePreviewParams[] = [];
    pricePreview = async (params) => {
      previewed.push(params);
      return {
        data: {
          details: {
            lineItems: [
              {
                price: {
                  id: "pri_distinctive_amount",
                  billingCycle: { interval: "month", frequency: 1 },
                },
                totals: { subtotal: "1020", discount: "0", tax: "214", total: "1234" },
                formattedTotals: {
                  subtotal: "€10.20",
                  discount: "€0.00",
                  tax: "€2.14",
                  total: "€12.34",
                },
              },
            ],
          },
        },
      } as unknown as PricePreviewResponse;
    };

    const card = await renderSubscribeCard((text) => text.includes("€12.34"));

    assert.match(card, /€12\.34 per month, including tax\. Cancel through Paddle\./);
    assert.deepEqual(previewed, [{ items: [{ priceId: "pri_distinctive_amount", quantity: 1 }] }]);
  });

  it("shows no amount and logs the failure when Paddle cannot answer", async () => {
    configureSandboxCheckout("pri_paddle_unavailable");
    pricePreview = async () => {
      throw new Error("Paddle unavailable");
    };
    const logged = mock.method(console, "error", () => undefined);

    const card = await renderSubscribeCard(() => logged.mock.callCount() > 0);
    logged.mock.restore();

    assert.ok(logged.mock.callCount() >= 1, "the Paddle failure is logged");
    assert.match(card, /Paddle shows the price at checkout\. Cancel through Paddle\./);
    assert.doesNotMatch(card, /\d/, "no price number may appear without Paddle's answer");
  });
});
