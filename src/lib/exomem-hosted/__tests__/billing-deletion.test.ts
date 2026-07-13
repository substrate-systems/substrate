import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { terminateExomemBillingForDeletion } from "../billing-deletion";
import type { ExomemPaddleConfig } from "../paddle-config";

const TENANT = "018f2d91-7c42-7000-8000-000000000095";
const USER = "018f2d91-7c42-7000-8000-000000000096";
const CONFIG: ExomemPaddleConfig = {
  environment: "sandbox",
  apiBaseUrl: "https://sandbox-api.paddle.com",
  productKey: "exomem-hosted",
  productId: "pro_01kxatbjfrehbp0sxbjefcacqs",
  priceId: "pri_01kxatbjfrehbp0sxbjefcacqs",
  checkoutUrl: "https://substratesystems.io/exomem/home",
  apiKey: "pdl_sdbx_test-key",
  webhookSecret: null,
  clientToken: null,
  clientEnvironment: null,
  paidCheckoutEnabled: false,
};

describe("Exomem billing termination", () => {
  it("completes complimentary deletion without any Paddle configuration or call", async () => {
    let called = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "complimentary",
        sourceState: "complimentary_active",
        sourceRevision: null,
        providerEnvironment: null,
        customerRef: null,
        subscriptionRef: null,
        transactionRef: null,
      }),
      transport: async () => {
        called = true;
        return new Response(null, { status: 500 });
      },
    });

    assert.equal(result?.tenantId, TENANT);
    assert.equal(called, false);
  });

  it("cancels a paid subscription immediately before permitting deletion", async () => {
    const subscriptionRef = `sub_${"a".repeat(26)}`;
    let path = "";
    let body = "";
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "active",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef,
        transactionRef: null,
      }),
      transport: async (nextPath, init) => {
        path = nextPath;
        body = String(init?.body);
        return Response.json({ data: { id: subscriptionRef, status: "canceled" } });
      },
    });

    assert.equal(result?.subscriptionRef, subscriptionRef);
    assert.equal(path, `/subscriptions/${subscriptionRef}/cancel`);
    assert.equal(body, JSON.stringify({ effective_from: "immediately" }));
  });

  it("keeps deletion pending when Paddle cannot prove termination", async () => {
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "active",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: `sub_${"b".repeat(26)}`,
        transactionRef: null,
      }),
      transport: async () => new Response("provider-sensitive-body", { status: 503 }),
    });

    assert.equal(result, null);
  });

  it("does not treat a wrong-account subscription 404 as termination proof", async () => {
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "active",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: `sub_${"z".repeat(26)}`,
        transactionRef: null,
      }),
      transport: async () => new Response(null, { status: 404 }),
    });

    assert.equal(result, null);
  });

  it("does not treat a wrong-account transaction 404 as termination proof", async () => {
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "checkout_pending",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: null,
        transactionRef: `txn_${"y".repeat(26)}`,
      }),
      transport: async () => new Response(null, { status: 404 }),
    });

    assert.equal(result, null);
  });

  it("does not call Paddle again when a retained subscription ref is already terminated", async () => {
    let called = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "deletion_cancelled",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: `sub_${"c".repeat(26)}`,
        transactionRef: null,
      }),
      transport: async () => {
        called = true;
        return new Response(null, { status: 503 });
      },
    });

    assert.equal(result?.sourceState, "deletion_cancelled");
    assert.equal(called, false);
  });

  it("requires matching provider provenance before accepting a provider-cancelled source state", async () => {
    let called = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "cancelled",
        sourceRevision: "evt_provider_cancelled",
        providerEnvironment: "production",
        customerRef: null,
        subscriptionRef: `sub_${"q".repeat(26)}`,
        transactionRef: null,
      }),
      transport: async () => {
        called = true;
        return new Response(null, { status: 500 });
      },
    });

    assert.equal(result, null);
    assert.equal(called, false);
  });

  it("owner-validates and cancels a pending transaction before marking deletion terminated", async () => {
    const transactionRef = `txn_${"d".repeat(26)}`;
    const calls: Array<{ path: string; method: string; body: string }> = [];
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "awaiting_checkout",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: null,
        transactionRef,
      }),
      transport: async (path, init) => {
        calls.push({
          path,
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return init?.method === "PATCH"
          ? Response.json({ data: { id: transactionRef, status: "canceled" } })
          : Response.json({
              data: {
                id: transactionRef,
                status: "ready",
                custom_data: {
                  product_key: "exomem-hosted",
                  user_id: USER,
                  tenant_id: TENANT,
                },
                items: [
                  {
                    price: {
                      id: CONFIG.priceId,
                      product_id: CONFIG.productId,
                    },
                  },
                ],
                checkout: {
                  url: `${CONFIG.checkoutUrl}?_ptxn=${transactionRef}`,
                },
              },
            });
      },
    });

    assert.equal(result?.transactionRef, transactionRef);
    assert.deepEqual(calls, [
      { path: `/transactions/${transactionRef}`, method: "GET", body: "" },
      {
        path: `/transactions/${transactionRef}`,
        method: "PATCH",
        body: JSON.stringify({ status: "canceled" }),
      },
    ]);
    assert.deepEqual(result, {
      tenantId: TENANT,
      userId: USER,
      source: "paddle",
      sourceState: "awaiting_checkout",
      sourceRevision: null,
      providerEnvironment: "sandbox",
      customerRef: null,
      subscriptionRef: null,
      transactionRef,
    });
  });

  it("cancels an owner-bound transaction after its checkout price is disabled or rotated", async () => {
    const transactionRef = `txn_${"g".repeat(26)}`;
    const cleanupConfig: ExomemPaddleConfig = {
      ...CONFIG,
      priceId: null,
      checkoutUrl: null,
      paidCheckoutEnabled: false,
    };
    const calls: string[] = [];
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: cleanupConfig,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "checkout_pending",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: null,
        transactionRef,
      }),
      transport: async (path, init) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        return init?.method === "PATCH"
          ? Response.json({ data: { id: transactionRef, status: "canceled" } })
          : Response.json({
              data: {
                id: transactionRef,
                status: "ready",
                custom_data: {
                  product_key: "exomem-hosted",
                  user_id: USER,
                  tenant_id: TENANT,
                },
                items: [
                  {
                    price: {
                      id: "pri_historical_server_selected",
                      product_id: CONFIG.productId,
                    },
                  },
                ],
              },
            });
      },
    });

    assert.equal(result?.transactionRef, transactionRef);
    assert.deepEqual(calls, [
      `GET /transactions/${transactionRef}`,
      `PATCH /transactions/${transactionRef}`,
    ]);
  });

  it("discovers and cancels the subscription attached to a completed transaction", async () => {
    const transactionRef = `txn_${"e".repeat(26)}`;
    const subscriptionRef = `sub_${"f".repeat(26)}`;
    const calls: Array<{ path: string; method: string; body: string }> = [];
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "checkout_pending",
        sourceRevision: null,
        providerEnvironment: "sandbox",
        customerRef: null,
        subscriptionRef: null,
        transactionRef,
      }),
      transport: async (path, init) => {
        calls.push({
          path,
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return path.startsWith("/transactions/")
          ? Response.json({
              data: {
                id: transactionRef,
                status: "completed",
                subscription_id: subscriptionRef,
                custom_data: {
                  product_key: "exomem-hosted",
                  user_id: USER,
                  tenant_id: TENANT,
                },
                items: [
                  {
                    price: {
                      id: CONFIG.priceId,
                      product_id: CONFIG.productId,
                    },
                  },
                ],
              },
            })
          : Response.json({ data: { id: subscriptionRef, status: "canceled" } });
      },
    });

    assert.equal(result?.transactionRef, transactionRef);
    assert.deepEqual(calls, [
      { path: `/transactions/${transactionRef}`, method: "GET", body: "" },
      {
        path: `/subscriptions/${subscriptionRef}/cancel`,
        method: "POST",
        body: JSON.stringify({ effective_from: "immediately" }),
      },
    ]);
  });

  it("refuses to touch Paddle when stored provenance belongs to another environment", async () => {
    let providerCalls = 0;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "active",
        sourceRevision: null,
        providerEnvironment: "production",
        customerRef: null,
        subscriptionRef: `sub_${"g".repeat(26)}`,
        transactionRef: null,
      }),
      transport: async () => {
        providerCalls += 1;
        return Response.json({});
      },
    });

    assert.equal(result, null);
    assert.equal(providerCalls, 0);
  });

  it("returns the exact provider fingerprint that the store must compare atomically", async () => {
    const subscriptionRef = `sub_${"h".repeat(26)}`;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        tenantId: TENANT,
        userId: USER,
        source: "paddle",
        sourceState: "active",
        sourceRevision: "evt_before_race",
        providerEnvironment: "sandbox",
        customerRef: `ctm_${"j".repeat(26)}`,
        subscriptionRef,
        transactionRef: `txn_${"i".repeat(26)}`,
      }),
      transport: async () => Response.json({ data: { id: subscriptionRef, status: "canceled" } }),
    });

    assert.deepEqual(result, {
      tenantId: TENANT,
      userId: USER,
      source: "paddle",
      sourceState: "active",
      sourceRevision: "evt_before_race",
      providerEnvironment: "sandbox",
      customerRef: `ctm_${"j".repeat(26)}`,
      subscriptionRef,
      transactionRef: `txn_${"i".repeat(26)}`,
    });
  });
});
