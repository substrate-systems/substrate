import assert from "node:assert/strict";
import test from "node:test";
import { CheckoutEventNames } from "@paddle/paddle-js";
import {
  reduceCheckoutEvent,
  formatCheckoutMoney,
  type InlineCheckoutState,
} from "../inline-checkout-state";

test("a stale or duplicate completion cannot finish a different owner transaction", () => {
  const loading: InlineCheckoutState = {
    transactionId: "txn_current",
    phase: "loading",
    data: null,
  };
  assert.equal(
    reduceCheckoutEvent(loading, {
      name: CheckoutEventNames.CHECKOUT_COMPLETED,
      data: { transaction_id: "txn_stale" } as never,
    }),
    loading
  );
  const completed = reduceCheckoutEvent(loading, {
    name: CheckoutEventNames.CHECKOUT_COMPLETED,
    data: { transaction_id: "txn_current" } as never,
  });
  assert.equal(completed.phase, "confirming");
  assert.equal(
    reduceCheckoutEvent(completed, {
      name: CheckoutEventNames.CHECKOUT_PAYMENT_FAILED,
      data: { transaction_id: "txn_current" } as never,
    }),
    completed
  );
});

test("a provider decline leaves the form retryable and a later initiation starts a new attempt", () => {
  const paying: InlineCheckoutState = { transactionId: "txn_current", phase: "paying", data: null };
  const declined = reduceCheckoutEvent(paying, {
    name: CheckoutEventNames.CHECKOUT_PAYMENT_FAILED,
    data: { transaction_id: "txn_current" } as never,
  });
  assert.equal(declined.phase, "failed");
  assert.equal(
    reduceCheckoutEvent(declined, {
      name: CheckoutEventNames.CHECKOUT_PAYMENT_INITIATED,
      data: { transaction_id: "txn_current" } as never,
    }).phase,
    "paying"
  );
});

test("checkout totals use Paddle's major units and each currency's decimals", () => {
  assert.equal(formatCheckoutMoney(13, "GBP"), "£13");
  assert.equal(formatCheckoutMoney(13, "GBP", true), "£13.00");
  assert.equal(formatCheckoutMoney(1500, "JPY", true), "JP¥1,500");
  assert.equal(formatCheckoutMoney(Number.NaN, "EUR"), null);
});
