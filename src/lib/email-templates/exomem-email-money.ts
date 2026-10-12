import type { ExomemMoney } from "@/lib/exomem-hosted/exomem-money";

/**
 * A price as Exomem shows it, in emails and on Home: "€10", or "€10.50" when
 * the amount has cents. The amount is Paddle's, in the currency's smallest
 * unit; it has at most 12 digits, so it is exact as a number.
 */
export function emailMoney(price: ExomemMoney): string {
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
