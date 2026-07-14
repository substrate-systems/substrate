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
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token",
    NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
    EXOMEM_PADDLE_PRODUCT_ID: "pro_server_selected",
    EXOMEM_PADDLE_PRICE_ID: priceId,
    EXOMEM_PUBLIC_BASE_URL: "https://substratesystems.io",
  };
}

async function withProcessEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
          checkout: {
            url: "https://substratesystems.io/exomem/home?_ptxn=txn_01kxatbjfrehbp0sxbjefcacqs",
          },
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
      checkout: {
        url: "https://substratesystems.io/exomem/home",
      },
    });
    assert.deepEqual(result, {
      checkoutUrl: "https://substratesystems.io/exomem/home?_ptxn=txn_01kxatbjfrehbp0sxbjefcacqs",
    });
    assert.deepEqual(recorded, {
      userId: "user-internal",
      tenantId: "tenant-internal",
      transactionId: "txn_01kxatbjfrehbp0sxbjefcacqs",
      environment: "sandbox",
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
                    checkout: {
                      url: "https://substratesystems.io/exomem/home?_ptxn=txn_01kxatbjfrehbp0sxbjefcacqs",
                    },
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
      {
        userId: "user-internal",
        tenantId: "tenant-internal",
        transactionId,
        environment: "sandbox",
      },
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
              checkout: {
                url: `https://substratesystems.io/exomem/home?_ptxn=${transactionId}`,
              },
            },
          });
        },
      }
    );

    assert.deepEqual(call, { path: `/transactions/${transactionId}`, method: "GET" });
    assert.deepEqual(result, {
      state: "open",
      checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${transactionId}`,
    });
  });

  it("returns a completed transaction for promotion instead of creating another checkout", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    const subscriptionId = `sub_${"a".repeat(26)}`;
    const customerId = `ctm_${"b".repeat(26)}`;
    const result = await resumeExomemCheckout(
      {
        userId: "user-internal",
        tenantId: "tenant-internal",
        transactionId,
        environment: "sandbox",
      },
      {
        config: loadExomemPaddleConfig(configEnv()),
        transport: async () =>
          Response.json({
            data: {
              id: transactionId,
              status: "completed",
              customer_id: customerId,
              subscription_id: subscriptionId,
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
    );

    assert.deepEqual(result, {
      state: "completed",
      customerId,
      subscriptionId,
    });
  });

  it("returns a canceled transaction for compare-clear replacement", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    const result = await resumeExomemCheckout(
      {
        userId: "user-internal",
        tenantId: "tenant-internal",
        transactionId,
        environment: "sandbox",
      },
      {
        config: loadExomemPaddleConfig(configEnv()),
        transport: async () =>
          Response.json({
            data: {
              id: transactionId,
              status: "canceled",
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
            },
          }),
      }
    );

    assert.deepEqual(result, { state: "canceled" });
  });

  it("recovers terminal transactions after checkout config and catalog rotate away", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    const subscriptionId = `sub_${"a".repeat(26)}`;
    const terminalEnv = configEnv();
    delete (terminalEnv as Partial<typeof terminalEnv>).NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    delete (terminalEnv as Partial<typeof terminalEnv>).EXOMEM_PUBLIC_BASE_URL;
    delete (terminalEnv as Partial<typeof terminalEnv>).EXOMEM_PADDLE_PRODUCT_ID;
    delete (terminalEnv as Partial<typeof terminalEnv>).EXOMEM_PADDLE_PRICE_ID;
    const terminalConfig = loadExomemPaddleConfig(terminalEnv);

    const completed = await resumeExomemCheckout(
      {
        userId: "user-internal",
        tenantId: "tenant-internal",
        transactionId,
        environment: "sandbox",
      },
      {
        config: terminalConfig,
        transport: async () =>
          Response.json({
            data: {
              id: transactionId,
              status: "completed",
              customer_id: null,
              subscription_id: subscriptionId,
              custom_data: {
                product_key: "exomem-hosted",
                user_id: "user-internal",
                tenant_id: "tenant-internal",
              },
              items: [
                {
                  price: {
                    id: "pri_historical_sale_price",
                    product_id: "pro_historical_product",
                  },
                },
              ],
            },
          }),
      }
    );

    assert.deepEqual(completed, {
      state: "completed",
      customerId: null,
      subscriptionId,
    });

    const canceled = await resumeExomemCheckout(
      {
        userId: "user-internal",
        tenantId: "tenant-internal",
        transactionId,
        environment: "sandbox",
      },
      {
        config: terminalConfig,
        transport: async () =>
          Response.json({
            data: {
              id: transactionId,
              status: "canceled",
              custom_data: {
                product_key: "exomem-hosted",
                user_id: "user-internal",
                tenant_id: "tenant-internal",
              },
              items: [
                {
                  price: {
                    id: "pri_historical_sale_price",
                    product_id: "pro_historical_product",
                  },
                },
              ],
            },
          }),
      }
    );

    assert.deepEqual(canceled, { state: "canceled" });

    const runtimeRecovered = await withProcessEnv(
      {
        ...configEnv(),
        NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_client_token",
        NEXT_PUBLIC_PADDLE_ENVIRONMENT: "production",
        EXOMEM_PADDLE_CATALOG_ENVIRONMENT: "production",
        EXOMEM_PUBLIC_BASE_URL: "not a public origin",
        EXOMEM_PADDLE_PRODUCT_ID: undefined,
        EXOMEM_PADDLE_PRICE_ID: "pri_historical_sale_price",
      },
      () =>
        resumeExomemCheckout(
          {
            userId: "user-internal",
            tenantId: "tenant-internal",
            transactionId,
            environment: "sandbox",
          },
          {
            transport: async () =>
              Response.json({
                data: {
                  id: transactionId,
                  status: "canceled",
                  custom_data: {
                    product_key: "exomem-hosted",
                    user_id: "user-internal",
                    tenant_id: "tenant-internal",
                  },
                  items: [],
                },
              }),
          }
        )
    );

    assert.deepEqual(runtimeRecovered, { state: "canceled" });
  });

  it("still requires current checkout configuration before reopening a live transaction", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    const openEnv = configEnv();
    delete (openEnv as Partial<typeof openEnv>).NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    delete (openEnv as Partial<typeof openEnv>).EXOMEM_PUBLIC_BASE_URL;
    delete (openEnv as Partial<typeof openEnv>).EXOMEM_PADDLE_PRODUCT_ID;
    delete (openEnv as Partial<typeof openEnv>).EXOMEM_PADDLE_PRICE_ID;
    let calls = 0;

    await assert.rejects(
      resumeExomemCheckout(
        {
          userId: "user-internal",
          tenantId: "tenant-internal",
          transactionId,
          environment: "sandbox",
        },
        {
          config: loadExomemPaddleConfig(openEnv),
          transport: async () => {
            calls += 1;
            return Response.json({
              data: {
                id: transactionId,
                status: "ready",
                custom_data: {
                  product_key: "exomem-hosted",
                  user_id: "user-internal",
                  tenant_id: "tenant-internal",
                },
                items: [],
                checkout: {
                  url: `https://checkout.paddle.test/exomem?_ptxn=${transactionId}`,
                },
              },
            });
          },
        }
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_PAID_CHECKOUT_DISABLED"
    );
    assert.equal(calls, 1);

    const runtimeOpen = await withProcessEnv(configEnv(), () =>
      resumeExomemCheckout(
        {
          userId: "user-internal",
          tenantId: "tenant-internal",
          transactionId,
          environment: "sandbox",
        },
        {
          transport: async () =>
            Response.json({
              data: {
                id: transactionId,
                status: "ready",
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
                checkout: {
                  url: `https://substratesystems.io/exomem/home?_ptxn=${transactionId}`,
                },
              },
            }),
        }
      )
    );

    assert.deepEqual(runtimeOpen, {
      state: "open",
      checkoutUrl: `https://substratesystems.io/exomem/home?_ptxn=${transactionId}`,
    });
  });

  it("rejects a completed transaction without a strict Paddle subscription ID", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    await assert.rejects(
      resumeExomemCheckout(
        {
          userId: "user-internal",
          tenantId: "tenant-internal",
          transactionId,
          environment: "sandbox",
        },
        {
          config: loadExomemPaddleConfig(configEnv()),
          transport: async () =>
            Response.json({
              data: {
                id: transactionId,
                status: "completed",
                subscription_id: "sub_not_strict",
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
              },
            }),
        }
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_BILLING_STATE_CONFLICT"
    );
  });

  it("rejects a correlated resume URL outside the configured Exomem checkout page", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    await assert.rejects(
      resumeExomemCheckout(
        {
          userId: "user-internal",
          tenantId: "tenant-internal",
          transactionId,
          environment: "sandbox",
        },
        {
          config: loadExomemPaddleConfig(configEnv()),
          transport: async () =>
            Response.json({
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
                checkout: {
                  url: `https://attacker.example/checkout?_ptxn=${transactionId}`,
                },
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
        environment: "sandbox",
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

  it("rejects missing or mismatched environment provenance before resume reaches Paddle", async () => {
    const transactionId = "txn_01kxatbjfrehbp0sxbjefcacqs";
    let calls = 0;
    const dependencies = {
      config: loadExomemPaddleConfig(configEnv()),
      transport: async () => {
        calls += 1;
        return Response.json({});
      },
    };

    await assert.rejects(
      resumeExomemCheckout(
        { userId: "user-internal", tenantId: "tenant-internal", transactionId } as never,
        dependencies
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_BILLING_INPUT_REJECTED"
    );
    await assert.rejects(
      resumeExomemCheckout(
        {
          userId: "user-internal",
          tenantId: "tenant-internal",
          transactionId,
          environment: "production",
        },
        dependencies
      ),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
    );
    assert.equal(calls, 0);
  });

  it("rejects missing or mismatched environment provenance before portal reaches Paddle", async () => {
    let calls = 0;
    const dependencies = {
      config: loadExomemPaddleConfig(configEnv()),
      transport: async () => {
        calls += 1;
        return Response.json({});
      },
    };
    const base = {
      userId: "user-internal",
      tenantId: "tenant-internal",
      customerId: "ctm_provider_internal_only",
      subscriptionId: "sub_provider_internal_only",
    };

    await assert.rejects(
      createExomemCustomerPortal(base as never, dependencies),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_BILLING_INPUT_REJECTED"
    );
    await assert.rejects(
      createExomemCustomerPortal({ ...base, environment: "production" }, dependencies),
      (error: unknown) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH"
    );
    assert.equal(calls, 0);
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
