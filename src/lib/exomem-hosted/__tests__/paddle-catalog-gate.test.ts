import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExomemPaddleCatalogGateError,
  verifyExomemPaddleCatalog,
  type ExomemPaddleCatalogTransport,
} from "../paddle-catalog-gate";
import type { ExomemPaddleConfig } from "../paddle-config";

function config(overrides: Partial<ExomemPaddleConfig> = {}): ExomemPaddleConfig {
  return {
    environment: "sandbox",
    apiBaseUrl: "https://sandbox-api.paddle.com",
    productKey: "exomem-hosted",
    productId: "pro_secret_product",
    priceId: "pri_secret_price",
    checkoutUrl: "https://staging.substratesystems.io/exomem/home",
    apiKey: "pdl_sdbx_secret_key",
    webhookSecret: "pdl_ntfset_secret",
    clientToken: "test_secret_client",
    clientEnvironment: "sandbox",
    paidCheckoutEnabled: true,
    ...overrides,
  };
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validTransport(): ExomemPaddleCatalogTransport {
  return async (path) => {
    if (path === "/products/pro_secret_product") {
      return response({ id: "pro_secret_product", status: "active" });
    }
    if (path === "/prices/pri_secret_price") {
      return response({
        id: "pri_secret_price",
        product_id: "pro_secret_product",
        status: "active",
        unit_price: { amount: "500", currency_code: "EUR" },
        billing_cycle: { interval: "month", frequency: 1 },
      });
    }
    return response({}, 404);
  };
}

describe("Exomem Paddle catalog deployment gate", () => {
  it("treats an absent sale price as checkout disabled without calling Paddle", async () => {
    let calls = 0;
    const result = await verifyExomemPaddleCatalog(config({ priceId: null }), async () => {
      calls += 1;
      return response({}, 500);
    });

    assert.deepEqual(result, { state: "disabled", environment: "sandbox" });
    assert.equal(calls, 0);
  });

  it("accepts only the active linked EUR 500 monthly catalog", async () => {
    const result = await verifyExomemPaddleCatalog(config(), validTransport());

    assert.deepEqual(result, {
      state: "verified",
      environment: "sandbox",
      productStatus: "active",
      priceStatus: "active",
      currency: "EUR",
      amount: "500",
      interval: "month",
      frequency: 1,
    });
  });

  for (const [name, mutate] of [
    ["inactive product", (value: Record<string, unknown>) => ({ ...value, status: "archived" })],
    ["wrong product", (value: Record<string, unknown>) => ({ ...value, product_id: "pro_other" })],
    [
      "wrong amount",
      (value: Record<string, unknown>) => ({
        ...value,
        unit_price: { amount: "1200", currency_code: "EUR" },
      }),
    ],
    [
      "wrong currency",
      (value: Record<string, unknown>) => ({
        ...value,
        unit_price: { amount: "500", currency_code: "USD" },
      }),
    ],
    [
      "wrong interval",
      (value: Record<string, unknown>) => ({
        ...value,
        billing_cycle: { interval: "year", frequency: 1 },
      }),
    ],
  ] as const) {
    it(`rejects ${name} without exposing catalog identifiers`, async () => {
      const transport: ExomemPaddleCatalogTransport = async (path) => {
        if (path.startsWith("/products/")) {
          const product = { id: "pro_secret_product", status: "active" };
          return response(name === "inactive product" ? mutate(product) : product);
        }
        const price = {
          id: "pri_secret_price",
          product_id: "pro_secret_product",
          status: "active",
          unit_price: { amount: "500", currency_code: "EUR" },
          billing_cycle: { interval: "month", frequency: 1 },
        };
        return response(mutate(price));
      };

      await assert.rejects(verifyExomemPaddleCatalog(config(), transport), (error: unknown) => {
        assert.ok(error instanceof ExomemPaddleCatalogGateError);
        assert.equal(error.code, "EXOMEM_PADDLE_CATALOG_INVALID");
        assert.doesNotMatch(error.message, /pro_secret|pri_secret|pdl_sdbx/);
        return true;
      });
    });
  }

  it("turns provider failures into a stable redacted error", async () => {
    await assert.rejects(
      verifyExomemPaddleCatalog(config(), async () => response({ id: "pri_secret_price" }, 403)),
      (error: unknown) => {
        assert.ok(error instanceof ExomemPaddleCatalogGateError);
        assert.equal(error.code, "EXOMEM_PADDLE_CATALOG_UNAVAILABLE");
        assert.equal(error.message, "EXOMEM_PADDLE_CATALOG_UNAVAILABLE");
        return true;
      }
    );
  });
});
