// A price as Exomem writes it: "€10", or "€10.50" when the amount has cents. The
// journey, Home and the emails all write prices through this one function.

/** An amount in the currency's minor units (Paddle's `totals`), and its ISO 4217 code. */
export type Money = { amount: string; currencyCode: string };

/** Amounts are at most 12 digits (Paddle's minor units), so they stay exact as numbers. */
export function formatMoney(price: Money): string {
  const fractionDigits =
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: price.currencyCode,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** fractionDigits;
  const minor = Number(price.amount);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: price.currencyCode,
    minimumFractionDigits: minor % scale === 0 ? 0 : fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(minor / scale);
}
