import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createExomemCheckout,
  createExomemCustomerPortal,
  ExomemBillingError,
  resumeExomemCheckout,
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
    let recorded: unknown;
    const transport: PaddleTransport = async (nextPath, init) => {
      path = nextPath;
      body = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          id: "txn_01kxatbjfrehbp0sxbjefcacqs",
          checkout: { url: "https://checkout.paddle.test/exomem" },
        },
      });
    };

    const result = await createExomemCheckout(
      { userId: "user-internal", tenantId: "tenant-internal" },
      {
        config: loadExomemPaddleConfig(configEnv()),
        transport,
        recordCheckoutTransaction: async (input) => {
          recorded = input;
          return true;
        },
      }
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
    assert.deepEqual(recorded, {
      userId: "user-internal",
      tenantId: "tenant-internal",
      transactionId: "txn_01kxatbjfrehbp0sxbjefcacqs",
    });
  });

  it("fails closed when the server-created transaction cannot bind to the tenant", async () => {
    const calls: Array<{ path: string; method: string; body: string }> = [];
    await assert.rejects(
      createExomemCheckout(
        { userId: "user-internal", tenantId: "tenant-internal" },
        {
          config: loadExomemPaddleConfig(configEnv()),
          transport: async (path, init) => {
            calls.push({
              path,
              method: init?.method ?? "GET",
              body: String(init?.body ?? ""),
            });
            return path === "/transactions"
              ? Response.json({
                  data: {
                    id: "txn_01kxatbjfrehbp0sxbjefcacqs",
                    checkout: { url: "https://checkout.paddle.test/exomem" },
                  },
                })
              : Response.json({ data: { status: "canceled" } });
          },
          recordCheckoutTransaction: async () => false,
        }
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError &&
        error.code === "EXOMEM_BILLING_STATE_CONFLICT" &&
        error.status === 409
    );
    assert.deepEqual(calls, [
      { path: "/transactions", method: "POST", body: calls[0]?.body ?? "" },
      {
        path: "/transactions/txn_01kxatbjfrehbp0sxbjefcacqs",
        method: "PATCH",
        body: JSON.stringify({ status: "canceled" }),
      },
    ]);
  });

  it("retrieves the stored Paddle transaction and verifies its owner-bound checkout", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    let call: { path: string; method: string } | undefined;
    const result = await resumeExomemCheckout(
      { userId: "user-internal", tenantId: "tenant-internal", transactionId },
      {
        config: loadExomemPaddleConfig(configEnv()),
        transport: async (path, init) => {
          call = { path, method: init?.method ?? "GET" };
          return Response.json({
            data: {
              id: transactionId,
              status: "draft",
              custom_data: {
                product_key: "exomem-hosted",
                user_id: "user-internal",
                tenant_id: "tenant-internal",
              },
              items: [
                {
                  price: {
                    id: "pri_server_selected",
                    product_id: "pro_server_selected",
                  },
                },
              ],
              checkout: { url: "https://checkout.paddle.test/resumed" },
            },
          });
        },
      }
    );

    assert.deepEqual(call, { path: `/transactions/${transactionId}`, method: "GET" });
    assert.deepEqual(result, { checkoutUrl: "https://checkout.paddle.test/resumed" });
  });

  it("does not reuse a terminal Paddle transaction even when a checkout URL remains", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    await assert.rejects(
      resumeExomemCheckout(
        { userId: "user-internal", tenantId: "tenant-internal", transactionId },
        {
          config: loadExomemPaddleConfig(configEnv()),
          transport: async () =>
            Response.json({
              data: {
                id: transactionId,
                status: "completed",
                custom_data: {
                  product_key: "exomem-hosted",
                  user_id: "user-internal",
                  tenant_id: "tenant-internal",
                },
                items: [
                  {
                    price: {
                      id: "pri_server_selected",
                      product_id: "pro_server_selected",
                    },
                  },
                ],
                checkout: { url: "https://checkout.paddle.test/stale" },
              },
            }),
        }
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_BILLING_STATE_CONFLICT"
    );
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
