import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  __clearExomemPriceCacheForTests,
  createExomemCheckout,
  ExomemBillingError,
  previewExomemPrices,
  readExomemNextPaymentAmount,
  type PaddleTransport,
} from "../paddle-billing";
import { loadExomemPaddleConfig } from "../paddle-config";

const BASE_PRICE = `pri_${"b".repeat(26)}`;
const FRIEND_DISCOUNT = `dsc_${"f".repeat(26)}`;

function config(friendDiscountId = FRIEND_DISCOUNT) {
  return loadExomemPaddleConfig({
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_API_KEY: "pdl_sdbx_apikey_example",
    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_client_token",
    NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
    EXOMEM_PADDLE_PRODUCT_ID: `pro_${"p".repeat(26)}`,
    EXOMEM_PADDLE_PRICE_ID: BASE_PRICE,
    EXOMEM_PADDLE_FRIEND_DISCOUNT_ID: friendDiscountId,
    EXOMEM_PUBLIC_BASE_URL: "https://substratesystems.io",
  });
}

function validDiscount(): Record<string, unknown> {
  return {
    id: FRIEND_DISCOUNT,
    status: "active",
    recur: true,
    maximum_recurring_intervals: null,
    code: null,
    enabled_for_checkout: false,
    restrict_to: [BASE_PRICE],
  };
}

function paddle(input: { discount?: Record<string, unknown>; appliesDiscount?: boolean } = {}) {
  const calls: string[] = [];
  const transport: PaddleTransport = async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path.startsWith("/discounts/"))
      return Response.json({ data: input.discount ?? validDiscount() });
    if (path === "/pricing-preview") {
      const discounted = body.discount_id === FRIEND_DISCOUNT && input.appliesDiscount !== false;
      return Response.json({
        data: {
          currency_code: "EUR",
          details: {
            line_items: [
              {
                price: { id: BASE_PRICE },
                totals: { total: discounted ? "1000" : "1500" },
                discounts: discounted ? [{ discount: { id: FRIEND_DISCOUNT } }] : [],
              },
            ],
          },
        },
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, transport };
}

beforeEach(() => __clearExomemPriceCacheForTests());

describe("the friend price at Paddle", () => {
  const leaks: Array<[string, Record<string, unknown>]> = [
    ["has a code anyone can type", { code: "FRIEND5" }],
    ["is enabled for checkout", { enabled_for_checkout: true }],
    ["reaches every price of the product", { restrict_to: [`pro_${"p".repeat(26)}`] }],
    ["is restricted to nothing", { restrict_to: null }],
    ["stops after some renewals", { maximum_recurring_intervals: 3 }],
    ["applies to the first payment only", { recur: false }],
    ["is archived", { status: "archived" }],
  ];
  for (const [problem, change] of leaks) {
    it(`refuses a friend checkout, creating no transaction, when the discount ${problem}`, async () => {
      const fake = paddle({ discount: { ...validDiscount(), ...change } });
      await assert.rejects(
        createExomemCheckout(
          { userId: "user-internal", tenantId: "tenant-internal" },
          {
            config: config(),
            transport: fake.transport,
            recordCheckoutTransaction: async () => true,
          },
          { friendPrice: true }
        ),
        (error) =>
          error instanceof ExomemBillingError && error.code === "EXOMEM_FRIEND_DISCOUNT_INVALID"
      );
      assert.equal(fake.calls.includes("POST /transactions"), false);
    });
  }

  it("refuses a configured discount id that is not a Paddle discount id before asking Paddle", async () => {
    const fake = paddle();
    await assert.rejects(
      createExomemCheckout(
        { userId: "user-internal", tenantId: "tenant-internal" },
        { config: config("FRIEND5"), transport: fake.transport },
        { friendPrice: true }
      ),
      (error) =>
        error instanceof ExomemBillingError && error.code === "EXOMEM_FRIEND_DISCOUNT_INVALID"
    );
    assert.deepEqual(fake.calls, []);
  });

  it("shows no friend price that Paddle's preview did not actually discount", async () => {
    const fake = paddle({ appliesDiscount: false });
    await assert.rejects(
      previewExomemPrices(
        { country: "DE", customerIp: "203.0.113.7", friend: true },
        { config: config(), transport: fake.transport }
      )
    );
  });

  it("serves a cached price only to the same country and only for ten minutes", async () => {
    const fake = paddle();
    let now = Date.parse("2026-10-12T10:00:00Z");
    const preview = (country: string) =>
      previewExomemPrices(
        { country, customerIp: "203.0.113.7", friend: false },
        { config: config(), transport: fake.transport, now: () => now }
      );
    await preview("DE");
    await preview("DE");
    await preview("FR");
    assert.equal(fake.calls.filter((call) => call === "POST /pricing-preview").length, 2);
    now += 10 * 60 * 1000 + 1;
    await preview("DE");
    assert.equal(fake.calls.filter((call) => call === "POST /pricing-preview").length, 3);
  });
});

describe("the next payment's amount", () => {
  it("reads Paddle afresh once a subscription event is applied, instead of serving the cached amount", async () => {
    const subscriptionId = `sub_${"s".repeat(26)}`;
    // Once the owner schedules a cancellation in the portal, Paddle previews no next payment.
    let cancelled = false;
    const reads: string[] = [];
    const transport: PaddleTransport = async (path) => {
      reads.push(path);
      return Response.json({
        data: {
          id: subscriptionId,
          currency_code: "EUR",
          next_transaction: cancelled
            ? null
            : { details: { totals: { grand_total: "1000", currency_code: "EUR" } } },
        },
      });
    };
    const read = (sourceRevision: string) =>
      readExomemNextPaymentAmount(
        { subscriptionId, environment: "sandbox", sourceRevision },
        { config: config(), transport, now: () => 0 }
      );

    const subscribed = "evt_subscription_created";
    assert.deepEqual((await read(subscribed)).value, { amount: "1000", currencyCode: "EUR" });
    // The webhook applies the scheduled cancellation, which stores its event id. Paddle can
    // stamp it in the same millisecond as the event before, so the time alone may not move.
    cancelled = true;
    const cancellationApplied = "evt_subscription_updated";
    assert.deepEqual(await read(cancellationApplied), { value: null, reason: "not_reported" });
    assert.equal(reads.length, 2);
    // With nothing stored changing, the cached answer still serves.
    await read(cancellationApplied);
    assert.equal(reads.length, 2);
  });
});
