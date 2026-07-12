import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createExomemCheckout,
  createExomemCustomerPortal,
  ExomemBillingError,
  type PaddleTransport,
} from "../paddle-billing";
import { loadExomemPaddleConfig } from "../paddle-config";

function configEnv(priceId = "pri_server_selected") {
  return {
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
    EXOMEM_PADDLE_PRODUCT_ID: "pro_server_selected",
    EXOMEM_PADDLE_PRICE_ID: priceId,
  };
}

describe("Exomem Paddle billing adapters", () => {
  it("creates checkout with only the server price and trusted correlation", async () => {
    let path = "";
    let body: unknown;
    const transport: PaddleTransport = async (nextPath, init) => {
      path = nextPath;
      body = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          id: "txn_secret_provider_id",
          checkout: { url: "https://checkout.paddle.test/exomem" },
        },
      });
    };

    const result = await createExomemCheckout(
      { userId: "user-internal", tenantId: "tenant-internal" },
      { config: loadExomemPaddleConfig(configEnv()), transport }
    );

    assert.equal(path, "/transactions");
    assert.deepEqual(body, {
      items: [{ price_id: "pri_server_selected", quantity: 1 }],
      custom_data: {
        product_key: "exomem-hosted",
        user_id: "user-internal",
        tenant_id: "tenant-internal",
      },
      collection_mode: "automatic",
    });
    assert.deepEqual(result, {
      checkoutUrl: "https://checkout.paddle.test/exomem",
    });
  });

  it("rejects arbitrary browser catalog fields before calling Paddle", async () => {
    let calls = 0;
    const transport: PaddleTransport = async () => {
      calls += 1;
      return Response.json({});
    };

    await assert.rejects(
      createExomemCheckout(
        {
          userId: "user-internal",
          tenantId: "tenant-internal",
          priceId: "pri_attacker_cheaper",
        } as never,
        { config: loadExomemPaddleConfig(configEnv()), transport }
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_BILLING_INPUT_REJECTED"
    );
    assert.equal(calls, 0);
  });

  it("returns a stable disabled error when no paid catalog price exists", async () => {
    const env = configEnv();
    delete (env as Partial<typeof env>).EXOMEM_PADDLE_PRICE_ID;
    let calls = 0;

    await assert.rejects(
      createExomemCheckout(
        { userId: "user-internal", tenantId: "tenant-internal" },
        {
          config: loadExomemPaddleConfig(env),
          transport: async () => {
            calls += 1;
            return Response.json({});
          },
        }
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_PAID_CHECKOUT_DISABLED"
    );
    assert.equal(calls, 0);
  });

  it("creates a customer portal from control-plane provider references", async () => {
    let path = "";
    let body: unknown;
    const transport: PaddleTransport = async (nextPath, init) => {
      path = nextPath;
      body = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          urls: {
            general: { overview: "https://customer-portal.paddle.test/session" },
          },
        },
      });
    };

    const result = await createExomemCustomerPortal(
      {
        userId: "user-internal",
        tenantId: "tenant-internal",
        customerId: "ctm_provider_internal_only",
        subscriptionId: "sub_provider_internal_only",
      },
      { config: loadExomemPaddleConfig(configEnv()), transport }
    );

    assert.equal(path, "/customers/ctm_provider_internal_only/portal-sessions");
    assert.deepEqual(body, {
      subscription_ids: ["sub_provider_internal_only"],
    });
    assert.deepEqual(result, {
      portalUrl: "https://customer-portal.paddle.test/session",
    });
  });

  it("never exposes Paddle response bodies or provider IDs in safe errors", async () => {
    const sentinel = "RAW_PADDLE_BODY sub_sensitive ctm_sensitive";
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await assert.rejects(
        createExomemCheckout(
          { userId: "user-internal", tenantId: "tenant-internal" },
          {
            config: loadExomemPaddleConfig(configEnv()),
            transport: async () => new Response(sentinel, { status: 500 }),
          }
        ),
        (error: unknown) => {
          assert.equal(error instanceof ExomemBillingError, true);
          assert.equal(String(error).includes(sentinel), false);
          return true;
        }
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(errors.join(" ").includes(sentinel), false);
  });
});
