import {
  CheckoutEventNames,
  type CheckoutEventsData,
  type PaddleEventData,
} from "@paddle/paddle-js";

export type InlineCheckoutPhase =
  | "loading"
  | "ready"
  | "paying"
  | "slow"
  | "failed"
  | "unavailable"
  | "confirming"
  | "ready_to_connect";
export type InlineCheckoutState = {
  transactionId: string | null;
  phase: InlineCheckoutPhase;
  data: CheckoutEventsData | null;
};

/** The SDK's documented events are protocol tokens; only this transaction may change its state. */
export function reduceCheckoutEvent(
  state: InlineCheckoutState,
  event: PaddleEventData
): InlineCheckoutState {
  if (
    !state.transactionId ||
    event.data?.transaction_id !== state.transactionId ||
    state.phase === "confirming" ||
    state.phase === "ready_to_connect"
  )
    return state;
  const data = event.data;
  switch (event.name) {
    case CheckoutEventNames.CHECKOUT_LOADED:
    case CheckoutEventNames.CHECKOUT_UPDATED:
    case CheckoutEventNames.CHECKOUT_ITEMS_UPDATED:
    case CheckoutEventNames.CHECKOUT_CUSTOMER_UPDATED:
    case CheckoutEventNames.CHECKOUT_DISCOUNT_APPLIED:
    case CheckoutEventNames.CHECKOUT_DISCOUNT_REMOVED:
      return { ...state, data, phase: state.phase === "loading" ? "ready" : state.phase };
    case CheckoutEventNames.CHECKOUT_PAYMENT_INITIATED:
      return { ...state, data, phase: "paying" };
    case CheckoutEventNames.CHECKOUT_PAYMENT_FAILED:
    case CheckoutEventNames.CHECKOUT_PAYMENT_ERROR:
      return { ...state, data, phase: "failed" };
    case CheckoutEventNames.CHECKOUT_ERROR:
      return { ...state, phase: "unavailable", data: null };
    case CheckoutEventNames.CHECKOUT_COMPLETED:
      return { ...state, data, phase: "confirming" };
    default:
      return state;
  }
}

/** Paddle.js event totals use major currency units, unlike the server API's minor units. */
export function formatCheckoutMoney(
  amount: number,
  currency: string,
  ledger = false
): string | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const format = new Intl.NumberFormat("en-GB", { style: "currency", currency });
  const decimals = format.resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: ledger || !Number.isInteger(amount) ? decimals : 0,
    maximumFractionDigits: decimals,
  }).format(amount);
}
