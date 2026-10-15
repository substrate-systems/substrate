import type { IncomingMessage, ServerResponse } from "node:http";

type Fixture = {
  subscription: {
    id: string;
    customer_id: string;
    status: string;
    updated_at: string;
    currency_code: string;
    billing_cycle: { interval: string; frequency: number };
    collection_mode: string;
    scheduled_change: null;
    custom_data: Record<string, unknown>;
    items: { price: { id: string }; quantity: number }[];
  };
  decline?: boolean;
  cardReady?: boolean;
  paid?: boolean;
  updates?: number;
};

/** The Paddle HTTP boundary, confined to this test server and synthetic fixtures. */
export function fakePaddle() {
  const fixtures = new Map<string, Fixture>();
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url!, "http://fixture.invalid");
    const control = url.pathname.startsWith("/__paddle-control/");
    if (!control && !url.pathname.startsWith("/__paddle-api/")) return false;
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
      return true;
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    if (control) {
      const id = url.pathname.slice("/__paddle-control/".length);
      if (body) fixtures.set(id, { ...fixtures.get(id), ...body });
      return reply(200, fixtures.get(id));
    }
    if (request.headers.authorization !== "Bearer pdl_sdbx_apikey_home_fixture")
      return reply(401, { error: { code: "invalid_api_key" } });
    const path = url.pathname.slice("/__paddle-api".length);
    const storagePrice = "pri_" + "b".repeat(26);
    if (path === `/prices/${storagePrice}`)
      return reply(200, {
        data: {
          id: storagePrice,
          product_id: "pro_" + "b".repeat(26),
          status: "active",
          trial_period: null,
          tax_mode: "location",
          billing_cycle: { interval: "month", frequency: 1 },
          quantity: { minimum: 1, maximum: 100 },
          custom_data: { exomem_storage_bytes: 10_000_000_000, exomem_storage_packs: [1, 5, 10] },
        },
      });
    const id = path.startsWith("/subscriptions/")
      ? path.split("/")[2]
      : url.searchParams.get("subscription_id");
    const fixture = id
      ? fixtures.get(id)
      : [...fixtures.values()].find((f) => path.endsWith(`txn_${f.subscription.id.slice(4)}`));
    if (!fixture) return reply(503, { error: { code: "fixture_unavailable" } });
    const subscription = fixture.subscription;
    const transactionId = `txn_${subscription.id.slice(4)}`;
    if (path.endsWith("/preview"))
      return reply(200, {
        data: {
          currency_code: subscription.currency_code,
          next_billed_at: "2026-12-01T00:00:00Z",
          consent_requirements: [],
          immediate_transaction: {
            details: {
              totals: { grand_total: "198", tax: "38", currency_code: subscription.currency_code },
            },
          },
          recurring_transaction_details: {
            totals: { grand_total: "1200", currency_code: subscription.currency_code },
          },
        },
      });
    if (path.endsWith("/update-payment-method-transaction") || path.startsWith("/transactions/"))
      return reply(200, {
        data: {
          id: transactionId,
          subscription_id: subscription.id,
          customer_id: subscription.customer_id,
          origin: "subscription_payment_method_change",
          status: fixture.cardReady ? "completed" : "ready",
        },
      });
    if (path === "/transactions")
      return reply(200, {
        data:
          fixture.paid !== false && subscription.custom_data.exomem_storage_operation
            ? [
                {
                  id: transactionId,
                  subscription_id: subscription.id,
                  customer_id: subscription.customer_id,
                  origin: "subscription_update",
                  status: "completed",
                  custom_data: subscription.custom_data,
                  items: subscription.items,
                  details: {
                    totals: {
                      grand_total: "197",
                      tax: "37",
                      currency_code: subscription.currency_code,
                    },
                  },
                },
              ]
            : [],
        meta: { pagination: { has_more: false } },
      });
    if (request.method === "PATCH") {
      fixture.updates = (fixture.updates ?? 0) + 1;
      if (fixture.decline) return reply(400, { error: { code: "subscription_payment_declined" } });
      if (
        body.proration_billing_mode !== "prorated_immediately" ||
        body.on_payment_failure !== "prevent_change"
      )
        return reply(400, { error: { code: "fixture_billing_rejected" } });
      subscription.items = body.items.map((item: { price_id: string; quantity: number }) => ({
        price: { id: item.price_id },
        quantity: item.quantity,
      }));
      subscription.custom_data = body.custom_data;
      subscription.updated_at = new Date().toISOString();
    }
    return reply(200, { data: subscription });
  };
}
