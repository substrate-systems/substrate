import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadExomemPaddleConfig } from "../paddle-config";
import {
  reconcileExomemPaddleSubscription,
  type PaddleReconciliationTarget,
} from "../paddle-reconciliation";
import type {
  AtomicExomemPaddleEventStore,
  ExomemPaddleEventApplication,
  ExomemPaddleStoreResult,
} from "../paddle-webhook";

function config() {
  return loadExomemPaddleConfig({
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
    EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem",
    EXOMEM_PADDLE_PRICE_ID: "pri_exomem",
  });
}

const target: PaddleReconciliationTarget = {
  userId: "user-internal",
  tenantId: "tenant-internal",
  subscriptionId: "sub_control_plane_only",
};

class CapturingStore implements AtomicExomemPaddleEventStore {
  applications: ExomemPaddleEventApplication[] = [];
  result: ExomemPaddleStoreResult = { outcome: "applied" };

  async applyVerifiedEventAndMarkProcessedAtomically(
    application: ExomemPaddleEventApplication
  ): Promise<ExomemPaddleStoreResult> {
    this.applications.push(application);
    return this.result;
  }
}

describe("periodic Paddle reconciliation seam", () => {
  it("reuses the atomic projection boundary without entering request-time paths", async () => {
    const store = new CapturingStore();
    let path = "";
    const result = await reconcileExomemPaddleSubscription(target, {
      config: config(),
      store,
      now: () => new Date("2026-07-12T13:00:00.000Z"),
      transport: async (nextPath) => {
        path = nextPath;
        return Response.json({
          data: {
            id: "sub_control_plane_only",
            customer_id: "ctm_control_plane_only",
            status: "past_due",
            updated_at: "2026-07-12T12:55:00.000Z",
            custom_data: {
              product_key: "exomem-hosted",
              user_id: "user-internal",
              tenant_id: "tenant-internal",
            },
            items: [{ price: { product_id: "pro_exomem" } }],
          },
        });
      },
    });

    assert.equal(path, "/subscriptions/sub_control_plane_only");
    assert.deepEqual(result, { outcome: "applied" });
    assert.equal(store.applications.length, 1);
    assert.equal(store.applications[0].origin, "reconciliation");
    assert.equal(store.applications[0].sourceState, "past_due");
    assert.deepEqual(store.applications[0].correlation, {
      productKey: "exomem-hosted",
      userId: "user-internal",
      tenantId: "tenant-internal",
    });
  });

  it("surfaces stale reconciliation as a normal monotonic outcome", async () => {
    const store = new CapturingStore();
    store.result = { outcome: "stale" };

    const result = await reconcileExomemPaddleSubscription(target, {
      config: config(),
      store,
      transport: async () =>
        Response.json({
          data: {
            id: "sub_control_plane_only",
            status: "active",
            updated_at: "2026-07-01T00:00:00.000Z",
            items: [{ price: { product_id: "pro_exomem" } }],
          },
        }),
    });

    assert.deepEqual(result, { outcome: "stale" });
  });

  it("fails closed when Paddle returns a different product catalog", async () => {
    const store = new CapturingStore();

    await assert.rejects(
      reconcileExomemPaddleSubscription(target, {
        config: config(),
        store,
        transport: async () =>
          Response.json({
            data: {
              id: "sub_control_plane_only",
              status: "active",
              items: [{ price: { product_id: "pro_other_product" } }],
            },
          }),
      }),
      (error: unknown) =>
        error instanceof Error && error.message === "EXOMEM_PADDLE_RECONCILIATION_INVALID"
    );
    assert.equal(store.applications.length, 0);
  });
});
