// The one shape of an amount of money in Exomem, shared by the server that reads it from
// Paddle and the pages that show it. Nothing here touches the server, so a page can
// import it.

/**
 * A price as Paddle reports a total: `amount` in the currency's smallest
 * unit (cents for EUR), tax included as Paddle computed it.
 */
export type ExomemMoney = { amount: string; currencyCode: string };

/** The shape of an `ExomemMoney` amount: at most 12 digits, so it stays exact as a number. */
export const MONEY_MINOR_UNITS = /^\d{1,12}$/;
// ISO 4217 code format; Paddle reports the currency it priced in.
export const CURRENCY_CODE = /^[A-Z]{3}$/;

/** True for an amount with the shape the server stores and sends. */
export function isExomemMoney(value: unknown): value is ExomemMoney {
  if (!value || typeof value !== "object") return false;
  const { amount, currencyCode } = value as Record<string, unknown>;
  return (
    typeof amount === "string" &&
    MONEY_MINOR_UNITS.test(amount) &&
    typeof currencyCode === "string" &&
    CURRENCY_CODE.test(currencyCode)
  );
}
