import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { terminateExomemBillingForDeletion } from "../billing-deletion";
import type { ExomemPaddleConfig } from "../paddle-config";

const TENANT = "018f2d91-7c42-7000-8000-000000000095";
const CONFIG: ExomemPaddleConfig = {
  environment: "sandbox",
  apiBaseUrl: "https://sandbox-api.paddle.com",
  productKey: "exomem-hosted",
  productId: "pro_01kxatbjfrehbp0sxbjefcacqs",
  priceId: null,
  apiKey: "pdl_sdbx_test-key",
  webhookSecret: null,
  clientToken: null,
  paidCheckoutEnabled: false,
};

describe("Exomem billing termination", () => {
  it("completes complimentary deletion without any Paddle configuration or call", async () => {
    let marked = false;
    let called = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      loadTarget: async () => ({
        source: "complimentary",
        sourceState: "complimentary_active",
        subscriptionRef: null,
      }),
      markTerminated: async () => {
        marked = true;
      },
      transport: async () => {
        called = true;
        return new Response(null, { status: 500 });
      },
    });

    assert.equal(result, true);
    assert.equal(marked, true);
    assert.equal(called, false);
  });

  it("cancels a paid subscription immediately before permitting deletion", async () => {
    const subscriptionRef = `sub_${"a".repeat(26)}`;
    let path = "";
    let body = "";
    let marked = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        source: "paddle",
        sourceState: "active",
        subscriptionRef,
      }),
      transport: async (nextPath, init) => {
        path = nextPath;
        body = String(init?.body);
        return Response.json({ data: { status: "canceled" } });
      },
      markTerminated: async () => {
        marked = true;
      },
    });

    assert.equal(result, true);
    assert.equal(path, `/subscriptions/${subscriptionRef}/cancel`);
    assert.equal(body, JSON.stringify({ effective_from: "immediately" }));
    assert.equal(marked, true);
  });

  it("keeps deletion pending when Paddle cannot prove termination", async () => {
    let marked = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        source: "paddle",
        sourceState: "active",
        subscriptionRef: `sub_${"b".repeat(26)}`,
      }),
      transport: async () => new Response("provider-sensitive-body", { status: 503 }),
      markTerminated: async () => {
        marked = true;
      },
    });

    assert.equal(result, false);
    assert.equal(marked, false);
  });

  it("does not call Paddle again when a retained subscription ref is already terminated", async () => {
    let marked = false;
    let called = false;
    const result = await terminateExomemBillingForDeletion(TENANT, {
      config: CONFIG,
      loadTarget: async () => ({
        source: "paddle",
        sourceState: "deletion_cancelled",
        subscriptionRef: `sub_${"c".repeat(26)}`,
      }),
      transport: async () => {
        called = true;
        return new Response(null, { status: 503 });
      },
      markTerminated: async () => {
        marked = true;
      },
    });

    assert.equal(result, true);
    assert.equal(marked, true);
    assert.equal(called, false);
  });
});
