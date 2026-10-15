import assert from "node:assert/strict";
import { it } from "node:test";
import {
  applyExomemFriendPriceToSubscription,
  createExomemCheckout,
  previewExomemPrices,
  type PaddleTransport,
} from "../paddle-billing";
import { loadExomemPaddleConfig } from "../paddle-config";

const regular = `pri_${"b".repeat(26)}`;
const friend = `pri_${"f".repeat(26)}`;
const storage = `pri_${"s".repeat(26)}`;
const product = `pro_${"p".repeat(26)}`;
const subscription = `sub_${"s".repeat(26)}`;
const transaction = `txn_${"t".repeat(26)}`;
const config = loadExomemPaddleConfig({
  PADDLE_ENVIRONMENT: "sandbox",
  PADDLE_API_KEY: "pdl_sdbx_apikey_example",
  NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token",
  NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
  EXOMEM_PUBLIC_BASE_URL: "https://example.test",
  EXOMEM_PADDLE_PRODUCT_ID: product,
  EXOMEM_PADDLE_PRICE_ID: regular,
  EXOMEM_PADDLE_FRIEND_PRICE_ID: friend,
});

it("creates a regional friend checkout without applying the legacy flat discount", async () => {
  let sent: Record<string, unknown> | undefined;
  const transport: PaddleTransport = async (path, init) => {
    assert.equal(path, "/transactions");
    sent = JSON.parse(String(init?.body));
    return Response.json({
      data: {
        id: transaction,
        discount_id: null,
        items: [{ price: { id: friend, product_id: product }, quantity: 1 }],
        checkout: { url: `https://example.test/exomem/home?_ptxn=${transaction}` },
      },
    });
  };
  await createExomemCheckout(
    { userId: "owner", tenantId: "tenant" },
    { config, transport, recordCheckoutTransaction: async () => true },
    { friendPrice: true }
  );
  assert.deepEqual(sent?.items, [{ price_id: friend, quantity: 1 }]);
  assert.equal(sent?.discount_id, undefined);
});

it("shows the regional friend's provider quote rather than subtracting a fixed discount", async () => {
  const transport: PaddleTransport = async (path, init) => {
    assert.equal(path, "/pricing-preview");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.discount_id, undefined);
    const priceId = body.items[0].price_id;
    return Response.json({
      data: {
        currency_code: "GBP",
        details: {
          line_items: [
            {
              price: { id: priceId },
              totals: { total: priceId === friend ? "900" : "1300" },
            },
          ],
        },
      },
    });
  };
  assert.deepEqual(
    await previewExomemPrices(
      { country: null, customerIp: "203.0.113.1", friend: true },
      { config, transport }
    ),
    {
      usual: { amount: "1300", currencyCode: "GBP" },
      friend: { amount: "900", currencyCode: "GBP" },
    }
  );
});

it("replaces only the base price and preserves add-ons, quantity and the renewal date", async () => {
  const nextBilledAt = "2026-11-12T09:00:00Z";
  const current = {
    id: subscription,
    status: "active",
    next_billed_at: nextBilledAt,
    discount: null,
    items: [
      { price: { id: regular, product_id: product }, quantity: 2 },
      { price: { id: storage, product_id: "pro_storage" }, quantity: 3 },
    ],
  };
  let updates = 0;
  const transport: PaddleTransport = async (path, init) => {
    assert.equal(path, `/subscriptions/${subscription}`);
    if (init?.method === "PATCH") {
      updates++;
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body, {
        proration_billing_mode: "do_not_bill",
        items: [
          { price_id: friend, quantity: 2 },
          { price_id: storage, quantity: 3 },
        ],
      });
      current.items[0].price.id = friend;
    }
    return Response.json({ data: current });
  };
  const input = { subscriptionId: subscription, environment: "sandbox" as const };
  assert.deepEqual(await applyExomemFriendPriceToSubscription(input, { config, transport }), {
    nextBilledAt: new Date(nextBilledAt).toISOString(),
  });
  // A lost response can retry after Paddle already changed the price.
  await applyExomemFriendPriceToSubscription(input, { config, transport });
  assert.equal(updates, 1);
});
